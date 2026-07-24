/**
 * Tests for the WAL-style transcript journal.
 *
 * All tests use real file I/O in concurrency-safe temp directories.
 * Scenarios covered:
 *   - Kill simulation: truncate journal mid-record, assert clean recovery
 *     to last good record.
 *   - Replay on top of snapshot: only records newer than snapshotTimestamp
 *     are returned.
 *   - Rotation after snapshot: journal file is deleted, next append
 *     recreates it with a fresh header.
 *   - Corrupt tail quarantine: unparseable tail is renamed to .unrecognized,
 *     replay returns all good records before the bad line.
 *   - schemaVersion gate: journal with an unknown version is quarantined.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  JOURNAL_SCHEMA_VERSION,
  journalPathFor,
  openTranscriptJournal,
  replayJournal,
  type JournalRecord,
} from '../../core/transcript-journal.ts';
import {
  replayJournalIntoConversation,
} from '../../core/session-recovery.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

// Minimal ConversationMessageSnapshot stub.
type MsgStub = { role: string; content: string };

function makeMessages(count: number): MsgStub[] {
  return Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` }));
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-journal-test');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('transcript-journal', () => {
  // ── journalPathFor ─────────────────────────────────────────────────────────

  test('journalPathFor builds canonical path', () => {
    const result = journalPathFor(makeTestSurface('/home/user'), 'ses-abc123');
    expect(result).toBe('/home/user/.goodvibes/tui/transcript-ses-abc123.journal');
  });

  // ── openTranscriptJournal + appendRecord ──────────────────────────────

  test('appendRecord creates journal file with header on first call', () => {
    const journalPath = join(tmpDir, 'transcript-s1.journal');
    const journal = openTranscriptJournal(journalPath, 's1');

    journal.appendRecord('user_message', makeMessages(1) as never);

    expect(existsSync(journalPath)).toBe(true);
    const lines = readLines(journalPath);
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + 1 record

    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(header['version']).toBe(JOURNAL_SCHEMA_VERSION);
    expect(header['sessionId']).toBe('s1');
    expect(typeof header['createdAt']).toBe('number');
  });

  test('each appendRecord increments seq monotonically', () => {
    const journalPath = join(tmpDir, 'transcript-seq.journal');
    const journal = openTranscriptJournal(journalPath, 'seq-session');
    const msgs = makeMessages(2) as never;

    journal.appendRecord('user_message', msgs);
    journal.appendRecord('assistant_turn', msgs);
    journal.appendRecord('tool_results', msgs);

    const lines = readLines(journalPath).slice(1); // skip header
    const records = lines.map((l) => JSON.parse(l) as JournalRecord);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  test('appendRecord creates parent directories lazily', () => {
    const nested = join(tmpDir, 'a', 'b', 'c', 'transcript-x.journal');
    const journal = openTranscriptJournal(nested, 'x');
    journal.appendRecord('user_message', makeMessages(1) as never);
    expect(existsSync(nested)).toBe(true);
  });

  // ── rotate ──────────────────────────────────────────────────────────────────

  test('rotate deletes the journal file', () => {
    const journalPath = join(tmpDir, 'transcript-rot.journal');
    const journal = openTranscriptJournal(journalPath, 'rot');
    journal.appendRecord('user_message', makeMessages(1) as never);
    expect(existsSync(journalPath)).toBe(true);

    journal.rotate();
    expect(existsSync(journalPath)).toBe(false);
  });

  test('rotate is a no-op when journal does not exist', () => {
    const journalPath = join(tmpDir, 'transcript-noexist.journal');
    const journal = openTranscriptJournal(journalPath, 'noexist');
    expect(() => journal.rotate()).not.toThrow();
  });

  test('appendRecord after rotate recreates the journal with fresh header', () => {
    const journalPath = join(tmpDir, 'transcript-rotate-recreate.journal');
    const journal = openTranscriptJournal(journalPath, 'rr');
    journal.appendRecord('user_message', makeMessages(1) as never);
    journal.rotate();

    // After rotate, seq resets and a fresh header is written.
    journal.appendRecord('user_message', makeMessages(2) as never);
    expect(existsSync(journalPath)).toBe(true);
    const lines = readLines(journalPath);
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(header['version']).toBe(JOURNAL_SCHEMA_VERSION);
    const record = JSON.parse(lines[1]) as JournalRecord;
    expect(record.seq).toBe(0); // seq reset after rotate
  });

  // ── replayJournal ──────────────────────────────────────────────────────────

  test('replayJournal returns empty result when journal does not exist', () => {
    const result = replayJournal(join(tmpDir, 'nonexistent.journal'), 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(false);
  });

  test('replayJournal returns records newer than snapshotTimestamp', () => {
    const journalPath = join(tmpDir, 'transcript-replay.journal');
    const journal = openTranscriptJournal(journalPath, 'rpl');
    const msgs = makeMessages(3) as never;

    // Simulate three turns at different times.
    const t0 = Date.now();
    journal.appendRecord('user_message', msgs);
    journal.appendRecord('assistant_turn', msgs);
    journal.appendRecord('user_message', msgs);

    // Only replay records after t0 - 1 (all three)
    const result = replayJournal(journalPath, t0 - 1);
    expect(result.records.length).toBe(3);
    expect(result.hadCorruptTail).toBe(false);
  });

  test('replayJournal filters records older than snapshotTimestamp', () => {
    const journalPath = join(tmpDir, 'transcript-filter.journal');
    const journal = openTranscriptJournal(journalPath, 'flt');
    const msgs = makeMessages(2) as never;

    journal.appendRecord('user_message', msgs);
    journal.appendRecord('assistant_turn', msgs);

    // Replay with a future timestamp — no records should be returned.
    const result = replayJournal(journalPath, Date.now() + 100_000);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(false);
  });

  test('replayJournal returns records in seq order', () => {
    const journalPath = join(tmpDir, 'transcript-order.journal');
    const journal = openTranscriptJournal(journalPath, 'ord');
    const msgs = makeMessages(2) as never;

    journal.appendRecord('user_message', msgs);
    journal.appendRecord('assistant_turn', msgs);
    journal.appendRecord('tool_results', msgs);

    const result = replayJournal(journalPath, 0);
    expect(result.records.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  // ── Kill simulation: corrupt tail ─────────────────────────────────────────

  test('kill simulation: truncate journal mid-record, recover to last good record', () => {
    const journalPath = join(tmpDir, 'transcript-kill.journal');
    const journal = openTranscriptJournal(journalPath, 'kill');
    const msgs = makeMessages(2) as never;

    journal.appendRecord('user_message', msgs); // record 0 — complete
    journal.appendRecord('assistant_turn', msgs); // record 1 — complete

    // Simulate SIGKILL mid-append: append a partial (truncated) JSON line
    // to simulate the killed write.
    appendFileSync(journalPath, '{"type":"user_message","seq":2,"ts":999,"mess'); // cut off

    // Replay should recover records 0 and 1, flag hadCorruptTail = true.
    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.seq).toBe(0);
    expect(result.records[1]!.seq).toBe(1);
    expect(result.hadCorruptTail).toBe(true);

    // Corrupt tail should be quarantined (file renamed to .unrecognized).
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${journalPath}.unrecognized`)).toBe(true);
  });

  test('truncated journal (zero bytes after header) recovers cleanly', () => {
    const journalPath = join(tmpDir, 'transcript-trunc.journal');
    const journal = openTranscriptJournal(journalPath, 'trunc');
    journal.appendRecord('user_message', makeMessages(1) as never);

    // Truncate to just the header line (first line).
    const lines = readLines(journalPath);
    writeFileSync(journalPath, lines[0] + '\n', 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(false); // header only is not corrupt
  });

  test('truncate mid-record with valid preceding records', () => {
    const journalPath = join(tmpDir, 'transcript-mid.journal');
    const journal = openTranscriptJournal(journalPath, 'mid');
    const msgs = makeMessages(1) as never;

    journal.appendRecord('user_message', msgs); // seq 0
    journal.appendRecord('assistant_turn', msgs); // seq 1

    // Truncate the file so seq 1 record is partial.
    const raw = readFileSync(journalPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    // Write only header + seq 0 + partial seq 1
    const partial = lines.slice(0, 2).join('\n') + '\n{"type":"assi';
    writeFileSync(journalPath, partial, 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(1); // only seq 0
    expect(result.records[0]!.seq).toBe(0);
    expect(result.hadCorruptTail).toBe(true);
  });

  // ── schemaVersion gate ──────────────────────────────────────────────────────

  test('schemaVersion gate: unknown version quarantines the file and returns empty', () => {
    const journalPath = join(tmpDir, 'transcript-badver.journal');
    // Write a journal with version 99 (unknown future version).
    const badHeader = JSON.stringify({ version: 99, sessionId: 's1', createdAt: Date.now() });
    const validRecord = JSON.stringify({ type: 'user_message', seq: 0, ts: Date.now(), messages: [] });
    writeFileSync(journalPath, `${badHeader}\n${validRecord}\n`, 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(true); // treated as corrupt
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${journalPath}.unrecognized`)).toBe(true);
  });

  test('schemaVersion gate: missing version field quarantines the file', () => {
    const journalPath = join(tmpDir, 'transcript-nover.journal');
    // Header missing version field.
    const badHeader = JSON.stringify({ sessionId: 's1', createdAt: Date.now() });
    writeFileSync(journalPath, `${badHeader}\n`, 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
  });

  test('schemaVersion gate: correct version passes and records are returned', () => {
    const journalPath = join(tmpDir, 'transcript-goodver.journal');
    const header = JSON.stringify({ version: JOURNAL_SCHEMA_VERSION, sessionId: 's1', createdAt: Date.now() });
    const record = JSON.stringify({ type: 'user_message', seq: 0, ts: Date.now(), messages: [] });
    writeFileSync(journalPath, `${header}\n${record}\n`, 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(1);
    expect(result.hadCorruptTail).toBe(false);
  });

  // ── Replay-on-top-of-snapshot ordering ─────────────────────────────────

  test('replay ordering: snapshot at t1 yields only records after t1', () => {
    const journalPath = join(tmpDir, 'transcript-snap.journal');
    const t0 = Date.now() - 2000; // 2 seconds ago
    const header = JSON.stringify({ version: JOURNAL_SCHEMA_VERSION, sessionId: 's1', createdAt: t0 });
    // Three records: one before t0 + 1000, two after.
    const snapshotTs = t0 + 1000;
    const r0 = JSON.stringify({ type: 'user_message', seq: 0, ts: t0 + 500, messages: [] });
    const r1 = JSON.stringify({ type: 'assistant_turn', seq: 1, ts: t0 + 1500, messages: [] });
    const r2 = JSON.stringify({ type: 'user_message', seq: 2, ts: t0 + 2000, messages: [] });
    writeFileSync(journalPath, `${header}\n${r0}\n${r1}\n${r2}\n`, 'utf-8');

    const result = replayJournal(journalPath, snapshotTs);
    // Only r1 (ts=t0+1500) and r2 (ts=t0+2000) are after snapshotTs (t0+1000).
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.seq).toBe(1);
    expect(result.records[1]!.seq).toBe(2);
    expect(result.hadCorruptTail).toBe(false);
  });

  // ── Corrupt JSON header ────────────────────────────────────────────────────

  test('corrupt JSON header quarantines file and returns empty', () => {
    const journalPath = join(tmpDir, 'transcript-badjson.journal');
    writeFileSync(journalPath, '{this is not valid json\n', 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
  });

  test('empty journal file returns no records without quarantine', () => {
    const journalPath = join(tmpDir, 'transcript-empty.journal');
    writeFileSync(journalPath, '', 'utf-8');

    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(false);
  });

  // ── Rotation after snapshot ─────────────────────────────────────────────────

  test('rotation after snapshot: journal deleted, next replay returns empty', () => {
    const journalPath = join(tmpDir, 'transcript-rotsnap.journal');
    const journal = openTranscriptJournal(journalPath, 'rotsnap');
    journal.appendRecord('user_message', makeMessages(1) as never);

    // Simulate snapshot written successfully. The snapshotTs value doesn't
    // matter here since the journal file is deleted — replay returns empty
    // regardless of the timestamp filter.
    journal.rotate(); // called by turn-event-wiring after persistConversation

    expect(existsSync(journalPath)).toBe(false);

    // After rotation, replay returns empty.
    const result = replayJournal(journalPath, 0);
    expect(result.records).toHaveLength(0);
    expect(result.hadCorruptTail).toBe(false);
  });

  test('rotation after snapshot then new appends are captured', () => {
    const journalPath = join(tmpDir, 'transcript-newcapture.journal');
    const journal = openTranscriptJournal(journalPath, 'nc');
    journal.appendRecord('user_message', makeMessages(1) as never);

    // Snapshot written, rotate. Use a past timestamp so post-rotate
    // records (which use Date.now()) are guaranteed to be newer.
    const snapshotTs = Date.now() - 100;
    journal.rotate();

    // New turn starts.
    journal.appendRecord('user_message', makeMessages(2) as never);
    journal.appendRecord('assistant_turn', makeMessages(3) as never);

    // Replay post-snapshot should find the two new records.
    const result = replayJournal(journalPath, snapshotTs);
    expect(result.records.length).toBe(2);
    expect(result.records[0]!.type).toBe('user_message');
    expect(result.records[1]!.type).toBe('assistant_turn');
  });

  // ── File mode ────────────────────────────────────────────────────────────

  test('journal file is created with 0o600 permissions', () => {
    const journalPath = join(tmpDir, 'transcript-perms.journal');
    const journal = openTranscriptJournal(journalPath, 'perms');
    journal.appendRecord('user_message', makeMessages(1) as never);

    const mode = statSync(journalPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ── replayJournalIntoConversation (session-recovery seam) ──────────────────

describe('replayJournalIntoConversation', () => {
  test('e2e: replays journal records onto conversation, writes snapshot, rotates journal', () => {
    const journalPath = join(tmpDir, 'transcript-e2e.journal');
    const sessionId = 'ses-e2e-test';
    const snapshotTimestamp = Date.now() - 5000; // snapshot taken 5s ago

    // Build journal with two post-snapshot records. Each record carries
    // the full conversation at that moment. The last record is authoritative.
    const earlyMessages = makeMessages(2);
    const latestMessages = makeMessages(4); // most recent, 4 messages
    const journal = openTranscriptJournal(journalPath, sessionId);
    journal.appendRecord('user_message', earlyMessages as never);
    journal.appendRecord('assistant_turn', latestMessages as never);

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;
    let persistedMessages: unknown[] = [];

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: (msgs) => {
        persistCalled = true;
        persistedMessages = msgs as unknown[];
      },
    });

    // Replayed 2 records.
    expect(result.replayed).toBe(2);
    expect(result.hadCorruptTail).toBe(false);

    // Conversation now reflects the last (most recent) journal record.
    expect(conversation.getMessageCount()).toBe(latestMessages.length);

    // persistSnapshot was called with the final record's messages.
    expect(persistCalled).toBe(true);
    expect(persistedMessages).toHaveLength(latestMessages.length);

    // Journal is rotated (deleted) after successful replay.
    expect(existsSync(journalPath)).toBe(false);
  });

  test('edge: all journal records older than snapshot — silent rotate, conversation unchanged', () => {
    const journalPath = join(tmpDir, 'transcript-old.journal');
    const sessionId = 'ses-old-test';
    const futureSnapshot = Date.now() + 100_000; // snapshot far in the future

    const journal = openTranscriptJournal(journalPath, sessionId);
    journal.appendRecord('user_message', makeMessages(2) as never);
    journal.appendRecord('assistant_turn', makeMessages(3) as never);

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: futureSnapshot,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // Nothing replayed — all records pre-date the snapshot timestamp.
    expect(result.replayed).toBe(0);
    expect(result.hadCorruptTail).toBe(false);

    // Conversation is empty (nothing was applied).
    expect(conversation.getMessageCount()).toBe(0);

    // persistSnapshot was NOT called.
    expect(persistCalled).toBe(false);

    // Journal is rotated (stale gap-filler deleted).
    expect(existsSync(journalPath)).toBe(false);
  });

  test('edge: journal corrupt from line 1 (bad JSON header) — quarantine, snapshot unchanged', () => {
    const journalPath = join(tmpDir, 'transcript-corrupt-header.journal');
    const sessionId = 'ses-corrupt-test';

    // Write a completely malformed journal.
    writeFileSync(journalPath, '{not valid json at all\n', 'utf-8');

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // Nothing replayed due to corrupt header.
    expect(result.replayed).toBe(0);
    expect(result.hadCorruptTail).toBe(true);

    // Conversation unchanged.
    expect(conversation.getMessageCount()).toBe(0);

    // persistSnapshot NOT called.
    expect(persistCalled).toBe(false);

    // File was quarantined.
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${journalPath}.unrecognized`)).toBe(true);
  });

  test('edge: journal schemaVersion mismatch — quarantine, no replay', () => {
    const journalPath = join(tmpDir, 'transcript-ver-mismatch.journal');
    const sessionId = 'ses-ver-test';

    // Write a journal with an unrecognised version.
    const badHeader = JSON.stringify({ version: 99, sessionId, createdAt: Date.now() });
    const validRecord = JSON.stringify({ type: 'user_message', seq: 0, ts: Date.now(), messages: makeMessages(2) });
    writeFileSync(journalPath, `${badHeader}\n${validRecord}\n`, 'utf-8');

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp: 0,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // Nothing replayed — version gate quarantined the file.
    expect(result.replayed).toBe(0);
    expect(result.hadCorruptTail).toBe(true);

    // Conversation unchanged, persistSnapshot not called.
    expect(conversation.getMessageCount()).toBe(0);
    expect(persistCalled).toBe(false);

    // File quarantined.
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${journalPath}.unrecognized`)).toBe(true);
  });

  test('e2e: partial corrupt tail — replays good records, flags hadCorruptTail', () => {
    const journalPath = join(tmpDir, 'transcript-partial-corrupt.journal');
    const sessionId = 'ses-partial-test';
    const snapshotTimestamp = Date.now() - 5000;

    // Write a valid header + one good record + truncated third line.
    const header = JSON.stringify({ version: JOURNAL_SCHEMA_VERSION, sessionId, createdAt: Date.now() });
    const goodRecord = JSON.stringify({ type: 'user_message', seq: 0, ts: Date.now(), messages: makeMessages(3) });
    writeFileSync(journalPath, `${header}\n${goodRecord}\n{"type":"assis`, 'utf-8');

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => { persistCalled = true; },
    });

    // 1 good record replayed, corrupt tail flagged.
    expect(result.replayed).toBe(1);
    expect(result.hadCorruptTail).toBe(true);

    // Conversation has the 3 messages from the good record.
    expect(conversation.getMessageCount()).toBe(3);

    // persistSnapshot called (we had records to replay).
    expect(persistCalled).toBe(true);

    // Journal file quarantined (renamed) by replayJournal.
    expect(existsSync(journalPath)).toBe(false);
  });
});
