/**
 * Seam-level replay tests — exercises each of the three wired resume paths.
 *
 * These tests drive the actual seam functions with real journals on disk,
 * asserting that replayed turns appear in the live conversation. They are
 * distinct from transcript-journal.test.ts (which tests the journal mechanics
 * in isolation) because they prove the *integration* between the journal
 * replay logic and the specific code paths a user would trigger.
 *
 * Seams covered:
 *   1. CLI / command resume — session-workflow.ts calls replayJournalForSession
 *      after fromJSON + rebuildHistory. Here we call the same function through
 *      the same arguments to verify the path is correctly wired.
 *   2. Ctrl+R crash recovery — handleBlockingShellInput with recoveryPending=true
 *      and a newer journal. Asserts replayed messages appear in conversation.
 *   3. In-TUI panel resume — createResumeSessionHandler with a real journal.
 *      Asserts replayed messages appear after the panel resume handler runs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  JOURNAL_SCHEMA_VERSION,
  journalPathFor,
  openTranscriptJournal,
} from '../../core/transcript-journal.ts';
import {
  replayJournalForSession,
  replayJournalIntoConversation,
} from '../../core/session-recovery.ts';
import { handleBlockingShellInput } from '../../shell/blocking-input.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { createResumeSessionHandler } from '../../runtime/bootstrap-hook-bridge.ts';
import type { ResumeSessionOptions } from '../../runtime/bootstrap-hook-bridge.ts';
import type { SessionSnapshot } from '@/runtime/index.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

type MsgStub = { role: string; content: string };

function makeMessages(count: number): MsgStub[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `seam-msg-${i}`,
  }));
}

/**
 * Write a valid journal with `recordCount` records, all post-dating
 * `snapshotTs`. Returns the path to the journal.
 */
function writeJournalWithRecords(
  journalPath: string,
  sessionId: string,
  recordCount: number,
  snapshotTs: number,
): void {
  const dir = join(journalPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const journal = openTranscriptJournal(journalPath, sessionId);
  // Sleep 1ms so ts > snapshotTs is guaranteed
  for (let i = 0; i < recordCount; i++) {
    // Manually write records with known ts values using low-level append
    // so we control the ts field precisely.
    journal.appendRecord(
      i === recordCount - 1 ? 'assistant_turn' : 'user_message',
      makeMessages(i + 2) as never,
    );
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-seam-replay-test');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ── Seam 1: CLI / command resume (session-workflow.ts path) ───────────────────

describe('seam-replay: seam 1 — CLI/command resume (replayJournalForSession)', () => {
  test('replays journal turns that post-date the snapshot into the conversation', () => {
    const sessionId = 'seam1-ses';
    const homeDirectory = tmpDir;
    const journalPath = journalPathFor(homeDirectory, sessionId);
    const snapshotTimestamp = Date.now() - 5000;

    // Write two post-snapshot records. Last record has 4 messages.
    writeJournalWithRecords(journalPath, sessionId, 2, snapshotTimestamp);

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;
    let persistedCount = 0;

    // This is the exact call made by session-workflow.ts after fromJSON.
    const result = replayJournalForSession({
      homeDirectory,
      sessionId,
      snapshotTimestamp,
      conversation,
      persistSnapshot: (msgs) => {
        persistCalled = true;
        persistedCount = msgs.length;
      },
    });

    expect(result.replayed).toBeGreaterThan(0);
    expect(conversation.getMessageCount()).toBeGreaterThan(0);
    expect(persistCalled).toBe(true);
    expect(persistedCount).toBeGreaterThan(0);
    // Journal rotated after replay.
    expect(existsSync(journalPath)).toBe(false);
  });

  test('no-op when journal is absent (no file on disk)', () => {
    const sessionId = 'seam1-nojournal';
    const homeDirectory = tmpDir;
    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const result = replayJournalForSession({
      homeDirectory,
      sessionId,
      snapshotTimestamp: Date.now(),
      conversation,
      persistSnapshot: () => { persistCalled = true; },
    });

    expect(result.replayed).toBe(0);
    expect(conversation.getMessageCount()).toBe(0);
    expect(persistCalled).toBe(false);
  });

  test('conversation title survives journal replay (regression for finding #18)', () => {
    // Regression: fromJSON({ messages }) with no title field was wiping conversation.title.
    const sessionId = 'seam1-title-survival';
    const homeDirectory = tmpDir;
    const snapshotTimestamp = Date.now() - 5000;

    writeJournalWithRecords(journalPathFor(homeDirectory, sessionId), sessionId, 1, snapshotTimestamp);

    const conversation = new ConversationManager(() => 80);
    // Pre-load a title as session-workflow.ts would after fromJSON.
    conversation.fromJSON({ messages: [] as never[], title: 'My Important Session', titleSource: 'user' });
    expect(conversation.title).toBe('My Important Session');

    const result = replayJournalForSession({
      homeDirectory,
      sessionId,
      snapshotTimestamp,
      conversation,
      persistSnapshot: () => {},
    });

    expect(result.replayed).toBeGreaterThan(0);
    // Title must survive the replay — it is not stored in journal records.
    expect(conversation.title).toBe('My Important Session');
  });
});

// ── Seam 2: Ctrl+R crash recovery (blocking-input.ts path) ───────────────────

describe('seam-replay: seam 2 — Ctrl+R crash recovery (handleBlockingShellInput)', () => {
  test('replays journal turns newer than the recovery snapshot timestamp', () => {
    const sessionId = 'seam2-ses';
    const homeDirectory = tmpDir;
    const journalPath = journalPathFor(homeDirectory, sessionId);
    const snapshotTimestamp = Date.now() - 5000;

    // Pre-populate journal with 3 post-snapshot records.
    writeJournalWithRecords(journalPath, sessionId, 3, snapshotTimestamp);

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    // Minimal system-message router stub.
    const systemMessageRouter = {
      high: (_msg: string) => {},
      low: (_msg: string) => {},
      normal: (_msg: string) => {},
    };

    // Recovery snapshot carries the timestamp so the ts-gate is applied.
    const recoverySnapshot: SessionSnapshot = {
      messages: [],
      title: 'seam2 test',
      titleSource: 'auto',
      timestamp: snapshotTimestamp,
    };

    const result = handleBlockingShellInput({
      data: '\x12', // Ctrl+R
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation,
      systemMessageRouter: systemMessageRouter as never,
      render: () => {},
      loadRecoveryConversation: () => recoverySnapshot,
      deleteRecoveryFile: () => {},
      homeDirectory,
      sessionId,
      persistSnapshot: (msgs) => {
        persistCalled = true;
        void msgs;
      },
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);
    // Conversation was populated via journal replay (3 records appended).
    expect(conversation.getMessageCount()).toBe(4);
    expect(persistCalled).toBe(true);
    // Journal cleaned up by rotate() inside replayJournalForSession.
    expect(existsSync(journalPath)).toBe(false);
  });

  test('recovers without journal when no journal exists (replay is a no-op)', () => {
    const sessionId = 'seam2-nojournal';
    const homeDirectory = tmpDir;
    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const systemMessageRouter = {
      high: (_msg: string) => {},
      low: (_msg: string) => {},
      normal: (_msg: string) => {},
    };

    const recoverySnapshot: SessionSnapshot = {
      messages: makeMessages(2) as never,
      title: 'seam2 nojournal test',
      titleSource: 'manual',
      timestamp: Date.now() - 1000,
    };

    const result = handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation,
      systemMessageRouter: systemMessageRouter as never,
      render: () => {},
      loadRecoveryConversation: () => recoverySnapshot,
      deleteRecoveryFile: () => {},
      homeDirectory,
      sessionId,
      persistSnapshot: (msgs) => {
        persistCalled = true;
        void msgs;
      },
    });

    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);
    // Messages from snapshot only (no journal to replay).
    expect(conversation.getMessageCount()).toBe(recoverySnapshot.messages.length);
    // No replay occurred, persistSnapshot not called by replay path.
    expect(persistCalled).toBe(false);
  });
});

// ── Seam 3: In-TUI panel resume (bootstrap-hook-bridge.ts path) ───────────────

describe('seam-replay: seam 3 — in-TUI panel resume (createResumeSessionHandler)', () => {
  test('replays journal turns newer than session snapshot onto conversation', () => {
    const sessionId = 'seam3-ses';
    const homeDirectory = tmpDir;
    const journalPath = journalPathFor(homeDirectory, sessionId);
    const snapshotTimestamp = Date.now() - 5000;

    // Pre-populate journal with 2 post-snapshot records.
    writeJournalWithRecords(journalPath, sessionId, 2, snapshotTimestamp);

    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    // Minimal stubs for the options required by createResumeSessionHandler.
    const sessionMeta = {
      title: 'seam3 test',
      titleSource: 'auto' as const,
      timestamp: snapshotTimestamp,
      model: 'test-model',
      provider: 'test-provider',
      returnContext: undefined,
    };

    const options: ResumeSessionOptions = {
      homeDirectory,
      conversation,
      requestRender: () => {},
      runtimeBus: { emit: () => {} } as never,
      runtime: {
        sessionId: 'previous-session',
        model: 'test-model',
        provider: 'test-provider',
      } as never,
      onSessionIdChanged: () => {},
      sharedSessionBroker: {
        reopenSession: () => Promise.resolve(),
      },
      writeLastSessionPointer: () => {},
      hookDispatcher: {
        fire: () => Promise.resolve({ fired: 0 }),
      } as never,
      sessionManager: {
        load: (_id: string) => ({ messages: [], meta: sessionMeta }),
        save: (_id: string, msgs: never[], _opts: unknown) => {
          persistCalled = true;
          void msgs;
        },
        list: () => [],
      } as never,
      panelManager: {
        open: () => {},
        show: () => {},
        hide: () => {},
      } as never,
      configManager: {
        get: (_key: string) => 'off',
        getCategory: (_cat: string) => ({}),
      } as never,
      providerRegistry: {
        get: () => null,
        getCurrentModel: () => 'test-model',
        getForModel: () => null,
        require: () => { throw new Error('not available'); },
      } as never,
    };

    const resumeSession = createResumeSessionHandler(options);
    resumeSession(sessionId);

    // After panel resume, journal records are replayed onto the conversation.
    expect(conversation.getMessageCount()).toBeGreaterThan(0);
    expect(persistCalled).toBe(true);
    // Journal cleaned up.
    expect(existsSync(journalPath)).toBe(false);
  });

  // footer token-counter hydration after resume. createResumeSessionHandler
  // must call the optional hydrateSessionUsage callback (wired from
  // bootstrap-shell.ts) after fromJSON()+journal replay are both applied, so the
  // caller can recompute orchestrator.usage from the now-complete history before
  // the next render — otherwise the footer shows Input: 0 post-resume.
  test('calls hydrateSessionUsage after fromJSON + journal replay, before requestRender', () => {
    const sessionId = 'seam3-hydrate';
    const homeDirectory = tmpDir;
    const journalPath = journalPathFor(homeDirectory, sessionId);
    const snapshotTimestamp = Date.now() - 5000;
    writeJournalWithRecords(journalPath, sessionId, 2, snapshotTimestamp);

    const conversation = new ConversationManager(() => 80);
    const callOrder: string[] = [];

    const sessionMeta = {
      title: 'seam3 hydrate test',
      titleSource: 'auto' as const,
      timestamp: snapshotTimestamp,
      model: 'test-model',
      provider: 'test-provider',
      returnContext: undefined,
    };

    let messageCountAtHydration = -1;
    const options: ResumeSessionOptions = {
      homeDirectory,
      conversation,
      requestRender: () => { callOrder.push('requestRender'); },
      runtimeBus: { emit: () => {} } as never,
      runtime: {
        sessionId: 'previous-session',
        model: 'test-model',
        provider: 'test-provider',
      } as never,
      onSessionIdChanged: () => {},
      sharedSessionBroker: {
        reopenSession: () => Promise.resolve(),
      },
      writeLastSessionPointer: () => {},
      hookDispatcher: {
        fire: () => Promise.resolve({ fired: 0 }),
      } as never,
      sessionManager: {
        load: (_id: string) => ({ messages: [], meta: sessionMeta }),
        save: (_id: string, msgs: never[], _opts: unknown) => { void msgs; },
        list: () => [],
      } as never,
      panelManager: {
        open: () => {},
        show: () => {},
        hide: () => {},
      } as never,
      configManager: {
        get: (_key: string) => 'off',
        getCategory: (_cat: string) => ({}),
      } as never,
      providerRegistry: {
        get: () => null,
        getCurrentModel: () => 'test-model',
        getForModel: () => null,
        require: () => { throw new Error('not available'); },
      } as never,
      hydrateSessionUsage: () => {
        callOrder.push('hydrateSessionUsage');
        messageCountAtHydration = conversation.getMessageCount();
      },
    };

    const resumeSession = createResumeSessionHandler(options);
    resumeSession(sessionId);

    expect(callOrder).toContain('hydrateSessionUsage');
    // hydrateSessionUsage ran before requestRender...
    expect(callOrder.indexOf('hydrateSessionUsage')).toBeLessThan(callOrder.indexOf('requestRender'));
    // ...and after the journal-replayed messages already landed on conversation.
    expect(messageCountAtHydration).toBe(conversation.getMessageCount());
    expect(messageCountAtHydration).toBeGreaterThan(0);
  });

  test('no-op when journal is absent for the resumed session', () => {
    const sessionId = 'seam3-nojournal';
    const homeDirectory = tmpDir;
    const conversation = new ConversationManager(() => 80);
    let persistCalled = false;

    const sessionMeta = {
      title: 'seam3 nojournal',
      titleSource: 'auto' as const,
      timestamp: Date.now() - 1000,
      model: 'test-model',
      provider: 'test-provider',
      returnContext: undefined,
    };

    const options: ResumeSessionOptions = {
      homeDirectory,
      conversation,
      requestRender: () => {},
      runtimeBus: { emit: () => {} } as never,
      runtime: {
        sessionId: 'prev',
        model: 'test-model',
        provider: 'test-provider',
      } as never,
      onSessionIdChanged: () => {},
      sharedSessionBroker: {
        reopenSession: () => Promise.resolve(),
      },
      writeLastSessionPointer: () => {},
      hookDispatcher: {
        fire: () => Promise.resolve({ fired: 0 }),
      } as never,
      sessionManager: {
        load: (_id: string) => ({ messages: [], meta: sessionMeta }),
        save: (_id: string, msgs: never[], _opts: unknown) => {
          persistCalled = true;
          void msgs;
        },
        list: () => [],
      } as never,
      panelManager: {
        open: () => {},
        show: () => {},
        hide: () => {},
      } as never,
      configManager: {
        get: (_key: string) => 'off',
        getCategory: (_cat: string) => ({}),
      } as never,
      providerRegistry: {
        get: () => null,
        getCurrentModel: () => 'test-model',
        getForModel: () => null,
        require: () => { throw new Error('not available'); },
      } as never,
    };

    const resumeSession = createResumeSessionHandler(options);
    resumeSession(sessionId);

    // No journal means no replay; only snapshot messages (none in our stub).
    expect(conversation.getMessageCount()).toBe(0);
    expect(persistCalled).toBe(false);
  });
});

// ── Regression: title/titleSource preserved across post-snapshot replay (T25) ─

describe('seam-replay: title/titleSource preservation (T25)', () => {
  test('post-snapshot replay preserves the seam-restored title and titleSource', () => {
    const sessionId = 'seam-title-ses';
    const homeDirectory = tmpDir;
    const journalPath = journalPathFor(homeDirectory, sessionId);
    const snapshotTimestamp = Date.now() - 5000;

    // Journal carries POST-snapshot records (messages only — journal records
    // never carry the title/titleSource).
    writeJournalWithRecords(journalPath, sessionId, 2, snapshotTimestamp);

    // The resume seam hydrates session identity (title + titleSource) onto the
    // live conversation BEFORE replay runs. Simulate that hydration.
    const conversation = new ConversationManager(() => 80);
    conversation.fromJSON({
      messages: [],
      title: 'Restored Session Title',
      titleSource: 'user',
    });
    expect(conversation.title).toBe('Restored Session Title');
    expect(conversation.getTitleSource()).toBe('user');

    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    // Records were replayed (messages applied)...
    expect(result.replayed).toBeGreaterThan(0);
    expect(conversation.getMessageCount()).toBeGreaterThan(0);

    // ...but the toJSON-spread fromJSON preserved the seam-restored identity.
    // A bare fromJSON({ messages }) would have blanked the title and reset
    // titleSource to the system default.
    expect(conversation.title).toBe('Restored Session Title');
    expect(conversation.getTitleSource()).toBe('user');
  });
});

// ── Regression: seq-collision authoritative-record selection (T30) ───────────

describe('seam-replay: seq-collision authoritative-record selection (T30)', () => {
  test('newest-ts append wins over a stale high-seq tail from a non-rotated journal', () => {
    const sessionId = 'seam-seqcollision';
    const journalPath = journalPathFor(tmpDir, sessionId);
    const snapshotTimestamp = Date.now() - 10_000;
    const base = Date.now() - 5000;

    // A prior process left this journal WITHOUT rotating: old records
    // (seq 0..2, earlier ts, STALE 10-message snapshots) are followed by a
    // fresh process's appends that restart at seq 0 (NEWER ts, CURRENT
    // 3-message snapshot). Sorting by seq alone leaves the stale seq-2 record
    // last — recovery must instead pick the record with the newest ts.
    const dir = join(journalPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const header = JSON.stringify({
      version: JOURNAL_SCHEMA_VERSION,
      sessionId,
      createdAt: base,
    });
    const stale = (seq: number, ts: number) =>
      JSON.stringify({ type: 'assistant_turn', seq, ts, messages: makeMessages(10) });
    const fresh = (seq: number, ts: number, count: number) =>
      JSON.stringify({ type: 'assistant_turn', seq, ts, messages: makeMessages(count) });
    writeFileSync(
      journalPath,
      [
        header,
        stale(0, base + 100),
        stale(1, base + 200),
        stale(2, base + 300), // sorts LAST by seq, but is STALE
        fresh(0, base + 1000, 2),
        fresh(1, base + 1100, 3), // NEWEST ts — authoritative
        '',
      ].join('\n'),
      'utf-8',
    );

    const conversation = new ConversationManager(() => 80);
    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    // All five records post-date the snapshot.
    expect(result.replayed).toBe(5);
    // Authoritative record is the newest-ts append (3 messages), NOT the stale
    // seq-2 record (10 messages) that the seq-sort leaves last.
    expect(conversation.getMessageCount()).toBe(3);
  });

  test('ties on ts are broken by the highest seq', () => {
    const sessionId = 'seam-seqtie';
    const journalPath = journalPathFor(tmpDir, sessionId);
    const snapshotTimestamp = Date.now() - 10_000;
    const sameTs = Date.now() - 1000;

    const dir = join(journalPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const header = JSON.stringify({
      version: JOURNAL_SCHEMA_VERSION,
      sessionId,
      createdAt: sameTs,
    });
    // Two records share the max ts; the higher seq carries the current state.
    const r0 = JSON.stringify({ type: 'assistant_turn', seq: 0, ts: sameTs, messages: makeMessages(7) });
    const r1 = JSON.stringify({ type: 'assistant_turn', seq: 1, ts: sameTs, messages: makeMessages(4) });
    writeFileSync(journalPath, [header, r0, r1, ''].join('\n'), 'utf-8');

    const conversation = new ConversationManager(() => 80);
    const result = replayJournalIntoConversation({
      journalPath,
      snapshotTimestamp,
      conversation,
      sessionId,
      persistSnapshot: () => {},
    });

    expect(result.replayed).toBe(2);
    // Tie on ts → highest seq (r1, 4 messages) wins.
    expect(conversation.getMessageCount()).toBe(4);
  });
});

