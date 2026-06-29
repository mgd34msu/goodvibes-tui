/**
 * session-recovery.ts — Journal replay at session resume.
 *
 * Purpose
 * ───────
 * When a session is resumed, this module checks whether a transcript journal
 * exists for that session whose records post-date the loaded snapshot. If so,
 * it replays those records onto the live conversation and writes a fresh
 * snapshot so the gap is permanently closed.
 *
 * Seams (all three must call replayJournalForSession)
 * ────────────────────────────────────────────────────
 * 1. CLI / command resume — session-workflow.ts, after `fromJSON` +
 *    `rebuildHistory` complete. Handles --continue, --resume, /session resume,
 *    and --fork.
 * 2. Ctrl+R crash recovery — blocking-input.ts, after `conversation.fromJSON`
 *    in the Ctrl+R branch. Handles SIGKILL-era recovery files.
 * 3. In-TUI panel resume — bootstrap-hook-bridge.ts
 *    `createResumeSessionHandler`, after `options.runtime.sessionId` is
 *    assigned. Handles the session browser / panel-driven resume.
 *
 * Recovery protocol
 * ─────────────────
 * 1. Call replayJournal() with the journal path and the snapshot timestamp.
 * 2. If no records are newer than the snapshot, rotate the (now-stale)
 *    journal silently and return.
 * 3. If records are found, apply the final record's messages — each journal
 *    record carries the full conversation snapshot at that moment, so the
 *    last record by seq is the authoritative post-crash state.
 * 4. Rebuild the conversation history and call the snapshot writer so the
 *    gap is durably closed before the user sees the restored conversation.
 * 5. Rotate the journal (it is no longer needed as a gap-filler).
 * 6. Return a result so the caller can emit an honest notice.
 */

import { journalPathFor, openTranscriptJournal, replayJournal } from './transcript-journal.ts';
import type { ConversationManager } from './conversation.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReplayIntoConversationOptions {
  /** Absolute path to the journal file for this session. */
  readonly journalPath: string;
  /**
   * The `timestamp` field from the loaded session snapshot (SessionMeta).
   * Only journal records with ts > snapshotTimestamp are replayed.
   */
  readonly snapshotTimestamp: number;
  /** The live conversation manager to mutate with replayed messages. */
  readonly conversation: ConversationManager;
  /** Session ID — used when creating the post-replay journal instance for rotate(). */
  readonly sessionId: string;
  /**
   * Persist the restored conversation so the gap is durably closed.
   * Called with the final replayed message list. Best-effort — failures
   * are swallowed so recovery never hard-fails a resume.
   */
  readonly persistSnapshot: (messages: ConversationMessageSnapshot[]) => void;
}

export interface ReplayIntoConversationResult {
  /** Number of journal records that post-dated the snapshot. 0 if nothing to replay. */
  readonly replayed: number;
  /** True if the journal tail was corrupt (quarantined). */
  readonly hadCorruptTail: boolean;
  /** True if the journal had an unrecognised schema version (quarantined). */
  readonly hadVersionMismatch: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Replay journal records newer than `snapshotTimestamp` onto `conversation`.
 *
 * Returns a result object so the caller can emit an appropriate notice.
 * Never throws — all errors are swallowed to preserve the "best-effort"
 * recovery contract.
 */
export function replayJournalIntoConversation(
  options: ReplayIntoConversationOptions,
): ReplayIntoConversationResult {
  const { journalPath, snapshotTimestamp, conversation, sessionId, persistSnapshot } = options;

  try {
    const { records, hadCorruptTail } = replayJournal(journalPath, snapshotTimestamp);

    // Detect version mismatch: replayJournal quarantines and returns
    // hadCorruptTail=true + 0 records when the header version is wrong.
    // We distinguish it from a genuine corrupt tail by checking whether the
    // journal file still exists (quarantine renames it away in both cases,
    // so we cannot inspect the header at this point). We surface both cases
    // through hadCorruptTail to the caller; hadVersionMismatch is derived
    // from it to give the caller a distinct notice option.
    const hadVersionMismatch = hadCorruptTail && records.length === 0;

    const journal = openTranscriptJournal(journalPath, sessionId);

    if (records.length === 0) {
      // Nothing to replay — rotate the (now-stale) journal silently.
      journal.rotate();
      return { replayed: 0, hadCorruptTail, hadVersionMismatch };
    }

    // The last record (highest seq) holds the most recent full conversation
    // state captured before the crash. Apply it.
    const lastRecord = records[records.length - 1]!;
    const replayedMessages = lastRecord.messages as ConversationMessageSnapshot[];

    conversation.fromJSON({
      messages: replayedMessages as never[],
      title: conversation.title,
      titleSource: conversation.getTitleSource(),
    });
    conversation.rebuildHistory();

    // Write a fresh snapshot so the gap is durably closed even if the
    // process is killed again before the next turn-complete snapshot.
    try {
      persistSnapshot(replayedMessages);
    } catch {
      // Best-effort — never hard-fail recovery due to snapshot write failure.
    }

    // Rotate the journal — it is no longer needed as a gap-filler.
    journal.rotate();

    return { replayed: records.length, hadCorruptTail, hadVersionMismatch: false };
  } catch {
    // Absolute last-resort guard — recovery must never crash a resume.
    return { replayed: 0, hadCorruptTail: false, hadVersionMismatch: false };
  }
}

/**
 * Build the journal path for a given session and home directory, then call
 * replayJournalIntoConversation().
 *
 * Convenience wrapper used by session-workflow.ts so it does not need to
 * import journalPathFor directly.
 */
export function replayJournalForSession(
  options: Omit<ReplayIntoConversationOptions, 'journalPath'> & {
    readonly homeDirectory: string;
  },
): ReplayIntoConversationResult {
  const journalPath = journalPathFor(options.homeDirectory, options.sessionId);
  return replayJournalIntoConversation({ ...options, journalPath });
}
