/**
 * transcript-journal.ts — WAL-style append-only transcript journal.
 *
 * Purpose
 * ───────
 * Between full snapshots (written by persistConversation / writeRecoveryFile),
 * a SIGKILL loses every conversation turn since the last snapshot. This module
 * provides an append-only journal that records each durable conversation event
 * (user message submitted, assistant turn finalised, tool results appended,
 * compaction performed) so that a kill at any moment loses at most the
 * in-flight append — never a full turn.
 *
 * File format (NDJSON)
 * ────────────────────
 * Line 0  — header:  { version: 1, sessionId: "...", createdAt: <epochMs> }
 * Line 1+ — records: { type, seq, ts, messages: ConversationMessageSnapshot[] }
 *
 * The header carries the schemaVersion so that a reader from a future process
 * can gate on it (readVersioned convention: unknown version → quarantine).
 *
 * Durability / performance tradeoff
 * ──────────────────────────────────
 * appendRecord() performs one appendFileSync + one fsyncSync per call.
 * This means one fsync per durable conversation event (user message,
 * assistant turn, tool result batch, compaction). It does NOT fsync per
 * streaming token — the streaming path never calls appendRecord().
 *
 * At typical usage (a few events per user turn), this is 2–6 fsyncs/min,
 * well within the durability/throughput envelope of any modern filesystem.
 * The tradeoff is explicit: we accept per-event write amplification in
 * exchange for at-most-one-record loss on SIGKILL.
 *
 * Recovery semantics
 * ──────────────────
 * 1. Read the header line. Gate on version — quarantine if unrecognised.
 * 2. Read subsequent lines until EOF. Stop at the first line that is not
 *    valid JSON or lacks the expected shape. Quarantine the remainder of
 *    the file from that point onward (rename to .unrecognized). Never crash.
 * 3. Return only records whose `ts` is strictly greater than the provided
 *    `snapshotTimestamp` (i.e. events that occurred after the last snapshot).
 * 4. Caller replays the returned records in `seq` order atop the snapshot
 *    to reconstruct the conversation, then writes a fresh snapshot and
 *    calls `journal.rotate()` to truncate the journal.
 *
 * Rotation
 * ────────
 * After a fresh snapshot is written, call journal.rotate() which deletes the
 * journal file. The next append will recreate it with a fresh header.
 *
 * Journal path convention
 * ───────────────────────
 * <homeDirectory>/.goodvibes/tui/transcript-<sessionId>.journal
 * This mirrors the recovery-file location (homeDirectory-scoped, not
 * workingDir-scoped) so all per-session durability artefacts live together.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

// ─── Constants ──────────────────────────────────────────────────────────────

export const JOURNAL_SCHEMA_VERSION = 1;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface JournalHeader {
  readonly version: typeof JOURNAL_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly createdAt: number;
}

export type JournalEventType =
  | 'user_message'
  | 'assistant_turn'
  | 'tool_results'
  | 'compaction';

export interface JournalRecord {
  /** Discriminator for the kind of durable event. */
  readonly type: JournalEventType;
  /** Monotonically increasing sequence number (0-based, per journal file). */
  readonly seq: number;
  /** Wall-clock timestamp (Date.now()) when the record was appended. */
  readonly ts: number;
  /** Full conversation message snapshot at the time of the event. */
  readonly messages: ConversationMessageSnapshot[];
}

export interface ReplayResult {
  /** Records whose ts is strictly after snapshotTimestamp, in seq order. */
  readonly records: JournalRecord[];
  /**
   * True if the journal tail was corrupt (a partial write from a kill).
   * The corrupt tail has been quarantined; replay stopped at the last
   * good record.
   */
  readonly hadCorruptTail: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface TranscriptJournal {
  /**
   * Append one durable event record and fsync it to disk.
   *
   * Best-effort: if the write fails (e.g. disk full), the error is swallowed
   * — the journal is durability-enhancing, never a hard requirement.
   */
  appendRecord(type: JournalEventType, messages: ConversationMessageSnapshot[]): void;

  /**
   * Delete the journal file (called after a fresh snapshot is written).
   * The next appendRecord() will recreate the file with a fresh header.
   * Best-effort — silently swallows errors.
   */
  rotate(): void;

  /** Absolute path to the journal file. */
  readonly path: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a TranscriptJournal for the given session.
 *
 * The journal file is created lazily on the first appendRecord() call.
 * Calling openTranscriptJournal() does not perform any I/O.
 */
export function openTranscriptJournal(
  journalPath: string,
  sessionId: string,
): TranscriptJournal {
  return new TranscriptJournalImpl(journalPath, sessionId);
}

/**
 * Build the canonical journal path for a session.
 *
 * @param homeDirectory  The goodvibes home directory (e.g. ~/.goodvibes).
 * @param sessionId      The session identifier.
 */
export function journalPathFor(homeDirectory: string, sessionId: string): string {
  return join(homeDirectory, '.goodvibes', 'tui', `transcript-${sessionId}.journal`);
}

/**
 * Replay journal records that post-date `snapshotTimestamp`.
 *
 * Returns an empty result if the journal file does not exist.
 * Corrupt tail lines (partial write from a kill) are quarantined; replay
 * stops at the first unparseable line.
 *
 * @param journalPath       Absolute path to the journal file.
 * @param snapshotTimestamp The `writtenAt` / `timestamp` of the last known
 *                          good snapshot. Only records with ts > this value
 *                          are returned.
 */
export function replayJournal(
  journalPath: string,
  snapshotTimestamp: number,
): ReplayResult {
  if (!existsSync(journalPath)) {
    return { records: [], hadCorruptTail: false };
  }

  let raw: string;
  try {
    raw = readFileSync(journalPath, 'utf-8');
  } catch {
    return { records: [], hadCorruptTail: false };
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { records: [], hadCorruptTail: false };
  }

  // ── Validate header ─────────────────────────────────────────────────────
  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    quarantineJournal(journalPath);
    return { records: [], hadCorruptTail: true };
  }

  if (
    !isPlainObject(header) ||
    typeof header['version'] !== 'number' ||
    header['version'] !== JOURNAL_SCHEMA_VERSION
  ) {
    quarantineJournal(journalPath);
    return { records: [], hadCorruptTail: true };
  }

  // ── Read records ────────────────────────────────────────────────────────
  const records: JournalRecord[] = [];
  let firstBadLine = -1;

  for (let i = 1; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      firstBadLine = i;
      break;
    }

    if (!isValidRecord(parsed)) {
      firstBadLine = i;
      break;
    }

    if (parsed.ts > snapshotTimestamp) {
      records.push(parsed);
    }
  }

  // ── Quarantine corrupt tail ──────────────────────────────────────────────
  let hadCorruptTail = false;
  if (firstBadLine !== -1) {
    hadCorruptTail = true;
    // Quarantine the remainder: rename the file. Caller will rotate after
    // replay anyway, but we quarantine now so the original file is not
    // accidentally replayed again if the process is killed during recovery.
    quarantineJournal(journalPath);
  }

  // Sort by seq to guarantee ordering in case lines were reordered (they
  // should not be, but be defensive).
  records.sort((a, b) => a.seq - b.seq);

  return { records, hadCorruptTail };
}

// ─── Implementation ─────────────────────────────────────────────────────────

class TranscriptJournalImpl implements TranscriptJournal {
  readonly path: string;
  private readonly _sessionId: string;
  private _seq = 0;
  private _initialised = false;

  constructor(journalPath: string, sessionId: string) {
    this.path = journalPath;
    this._sessionId = sessionId;
  }

  appendRecord(type: JournalEventType, messages: ConversationMessageSnapshot[]): void {
    try {
      this._ensureInitialised();
      const record: JournalRecord = {
        type,
        seq: this._seq++,
        ts: Date.now(),
        messages,
      };
      const line = JSON.stringify(record) + '\n';
      appendFileSync(this.path, line, { mode: 0o600 });
      // fsync to flush the append to durable storage before returning.
      const fd = openSync(this.path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Best-effort — never crash the TUI over a journal failure.
    }
  }

  rotate(): void {
    try {
      if (existsSync(this.path)) {
        unlinkSync(this.path);
      }
      this._initialised = false;
      this._seq = 0;
    } catch {
      // Best-effort.
    }
  }

  private _ensureInitialised(): void {
    if (this._initialised && existsSync(this.path)) return;

    mkdirSync(dirname(this.path), { recursive: true });
    const header: JournalHeader = {
      version: JOURNAL_SCHEMA_VERSION,
      sessionId: this._sessionId,
      createdAt: Date.now(),
    };
    // Append the header as the first line. If the file already exists (e.g.
    // process restarted mid-session), we start appending records after
    // whatever is already there — the replay function handles seq ordering.
    // However, to keep things clean, if the file doesn't exist we write fresh.
    if (!existsSync(this.path)) {
      appendFileSync(this.path, JSON.stringify(header) + '\n', { mode: 0o600 });
    }
    this._initialised = true;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRecord(value: unknown): value is JournalRecord {
  if (!isPlainObject(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['type'] === 'string' &&
    typeof v['seq'] === 'number' &&
    typeof v['ts'] === 'number' &&
    Array.isArray(v['messages'])
  );
}

function quarantineJournal(journalPath: string): void {
  try {
    renameSync(journalPath, `${journalPath}.unrecognized`);
  } catch {
    // Best-effort — if rename fails, proceed silently.
  }
}
