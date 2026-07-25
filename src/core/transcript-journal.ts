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
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { UNRECOGNIZED_SUFFIX } from '@/config/read-versioned.ts';
import type { SessionSurface } from '@/runtime/index.ts';

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

  /**
   * Point this journal at a different session's file, resetting the sequence
   * counter and initialization flag. Used when the session a journal was
   * opened for is switched out from under it (e.g. `/session resume` or
   * `/session fork` reassigning `runtime.sessionId`) — without this, the
   * journal keeps appending the NEW session's records into the OLD session's
   * file. Does not touch the old file on disk; it is simply no longer
   * written to.
   */
  rebind(journalPath: string, sessionId: string): void;
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
 * Both the home directory and the scope segment come off the caller's
 * SessionSurface, so the journal lands beside the sessions and recovery
 * snapshots it fills gaps for rather than under a separately-spelled scope.
 *
 * @param surface    The app's declare-once session-storage handle.
 * @param sessionId  The session identifier.
 */
export function journalPathFor(surface: SessionSurface, sessionId: string): string {
  return join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot, `transcript-${sessionId}.journal`);
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
  // Not `readonly` at the class level (unlike the public interface) so
  // rebind() can repoint it; external callers only ever see it through the
  // `TranscriptJournal` interface, which keeps it read-only for them.
  path: string;
  private _sessionId: string;
  private _seq = 0;
  private _initialised = false;

  constructor(journalPath: string, sessionId: string) {
    this.path = journalPath;
    this._sessionId = sessionId;
  }

  rebind(journalPath: string, sessionId: string): void {
    this.path = journalPath;
    this._sessionId = sessionId;
    this._seq = 0;
    this._initialised = false;
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
    if (this._initialised && journalHasContent(this.path)) return;

    mkdirSync(dirname(this.path), { recursive: true });
    const header: JournalHeader = {
      version: JOURNAL_SCHEMA_VERSION,
      sessionId: this._sessionId,
      createdAt: Date.now(),
    };
    // Append the header as the first line. If the file already exists with
    // content (e.g. process restarted mid-session), we start appending records
    // after whatever is already there — the replay function handles seq
    // ordering.
    //
    // The guard is `journalHasContent`, not `existsSync`: a crash between
    // creating the file and writing the header leaves a zero-byte journal, and
    // an existence-only check would then skip the header forever. Every record
    // appended after that would sit in a header-less file, so the next replay
    // would read record 0 where the header belongs, fail the version gate, and
    // quarantine the entire journal — losing exactly the turns this module
    // exists to preserve. Deciding on content instead means a zero-byte
    // journal is re-headered and stays replayable.
    if (!journalHasContent(this.path)) {
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
    renameSync(journalPath, `${journalPath}${UNRECOGNIZED_SUFFIX}`);
  } catch {
    // Best-effort — if rename fails, proceed silently.
  }
}

/** True when the journal file exists AND holds at least one byte. */
function journalHasContent(journalPath: string): boolean {
  try {
    return statSync(journalPath).size > 0;
  } catch {
    return false;
  }
}

// ─── Reaping orphaned journals ──────────────────────────────────────────────
//
// `rotate()` deletes a journal once its records have been folded into a
// snapshot or replayed. A session that crashes and is never resumed never
// reaches either, so its journal stays on disk forever — one file per
// abandoned session. The SDK's registered append-only retention sweep does not
// cover this home-scoped path, so the reclaim happens here.

const JOURNAL_PREFIX = 'transcript-';
const JOURNAL_SUFFIX = '.journal';

/** How long an untouched journal for a non-live session is kept: 7 days. */
export const JOURNAL_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on reapable journals kept after the age rule, newest kept.
 * A burst of crashes inside the age window is still bounded.
 */
export const JOURNAL_ORPHAN_MAX_FILES = 50;

export interface JournalReapResult {
  /** Journal files examined this sweep. */
  readonly scanned: number;
  /** Journal files deleted this sweep. */
  readonly reaped: number;
}

export interface JournalReapOptions {
  /**
   * Is this session open in a still-running process? Injected rather than
   * imported so this module keeps no dependency on the liveness marker — the
   * composition point (runtime/durability-housekeeping.ts) supplies the real
   * check, and tests supply their own.
   */
  readonly isSessionLive: (sessionId: string) => boolean;
  /** The session this process is writing right now; never reaped. */
  readonly currentSessionId?: string | null;
  readonly now?: () => number;
  /** Override the age window (tests). */
  readonly maxAgeMs?: number;
  /** Override the count cap (tests). */
  readonly maxFiles?: number;
}

/**
 * Delete transcript journals belonging to sessions that crashed and were never
 * resumed.
 *
 * A journal is reapable only when it is neither the current session's nor
 * apparently open in another running process. Of those, one is deleted when it
 * is empty (a zero-byte file holds no records, so nothing can be lost) or
 * untouched for longer than the age window; whatever survives both rules is
 * then capped by count, newest kept.
 *
 * The rules are deliberately mtime- and liveness-based, never parse-based: an
 * unparseable TAIL is the normal, expected shape of a journal killed
 * mid-append and is exactly the data replay is there to salvage, so a parse
 * failure must never make a journal reapable.
 *
 * Idempotent and concurrency-safe: a journal another sweeper unlinked between
 * the listing and this unlink (ENOENT) counts as reaped, not as an error.
 */
export function reapOrphanedJournals(surface: SessionSurface, options: JournalReapOptions): JournalReapResult {
  const dir = join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(JOURNAL_PREFIX) && n.endsWith(JOURNAL_SUFFIX));
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const now = options.now?.() ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? JOURNAL_ORPHAN_MAX_AGE_MS;
  const maxFiles = options.maxFiles ?? JOURNAL_ORPHAN_MAX_FILES;

  let reaped = 0;
  const survivors: { readonly path: string; readonly mtimeMs: number }[] = [];

  for (const name of names) {
    const sessionId = name.slice(JOURNAL_PREFIX.length, name.length - JOURNAL_SUFFIX.length);
    if (sessionId.length === 0) continue;
    if (options.currentSessionId && sessionId === options.currentSessionId) continue;
    if (options.isSessionLive(sessionId)) continue;

    const path = join(dir, name);
    let stats: { size: number; mtimeMs: number };
    try {
      stats = statSync(path);
    } catch {
      continue; // vanished under us
    }
    if (stats.size === 0 || now - stats.mtimeMs > maxAgeMs) {
      if (unlinkJournalIfPresent(path)) reaped++;
      continue;
    }
    survivors.push({ path, mtimeMs: stats.mtimeMs });
  }

  if (survivors.length > maxFiles) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const victim of survivors.slice(0, survivors.length - maxFiles)) {
      if (unlinkJournalIfPresent(victim.path)) reaped++;
    }
  }

  return { scanned: names.length, reaped };
}

function unlinkJournalIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
}
