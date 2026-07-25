/**
 * rewind-turn-anchors.ts — the session-scoped join key between the conversation
 * and the workspace-checkpoint store, for message-anchored rewind.
 *
 * The unified rewind service (SDK platform/rewind) anchors a rewind to a
 * `{ sessionId, turnId }`. Files-scope resolves that turnId against the
 * workspace checkpoints the turn engine already stamps with the same turnId.
 * Conversation-scope, however, needs to know HOW MANY conversation messages
 * existed at that turn boundary — a mapping the SDK's checkpoint store does not
 * carry (TUI turn-checkpoints are not stamped with a conversation-message
 * count). This registry supplies exactly that mapping: at every TURN_COMPLETED
 * the TUI records the turnId together with the live `conversation.getMessageCount()`,
 * so a later rewind to that turnId can truncate the conversation to precisely
 * the boundary the files checkpoint captured.
 *
 * Scope + lifetime: in-memory, keyed by sessionId. The registry is the live
 * working copy; it is mirrored to a small per-session sidecar file next to the
 * session's JSONL (`<sessionsDir>/<sessionId>.anchors.json`) at every turn, and
 * `restoreTurnAnchors` reloads that sidecar on resume so message-anchored
 * /rewind works identically before and after a resume. The sidecar's
 * `messageCount` boundaries stay valid because a resume rehydrates the same
 * message history the anchors were recorded against.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';


/** One recorded turn boundary — the rewind coordinator's per-turn anchor. */
export interface TurnAnchor {
  /** The turn engine's turn id, shared with the workspace checkpoint's `turnId`. */
  readonly turnId: string;
  /** A short human label (the truncated user prompt) for the recent-turns picker. */
  readonly label: string;
  /** `conversation.getMessageCount()` captured at this turn's completion — the conversation truncation boundary. */
  readonly messageCount: number;
  /** Wall-clock ms at capture, for ordering + age display. */
  readonly at: number;
}

/** Hard cap so a very long session cannot grow this registry without bound. */
const MAX_ANCHORS_PER_SESSION = 500;

const registry = new Map<string, TurnAnchor[]>();

/** Trim a user prompt to a single compact line for the picker. */
export function summarizeTurnLabel(text: string | null | undefined, max = 72): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return '(no prompt text)';
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Record a completed turn's anchor. Idempotent per turnId: a repeated turnId
 * updates the existing entry in place (the checkpoint engine can re-snapshot a
 * turn) rather than duplicating it.
 */
export function recordTurnAnchor(sessionId: string, anchor: TurnAnchor): void {
  if (!sessionId || !anchor.turnId) return;
  const list = registry.get(sessionId) ?? [];
  const existingIndex = list.findIndex((a) => a.turnId === anchor.turnId);
  if (existingIndex >= 0) {
    list[existingIndex] = anchor;
  } else {
    list.push(anchor);
    if (list.length > MAX_ANCHORS_PER_SESSION) list.splice(0, list.length - MAX_ANCHORS_PER_SESSION);
  }
  registry.set(sessionId, list);
}

/** All recorded anchors for a session, oldest first (chronological). */
export function getTurnAnchors(sessionId: string): readonly TurnAnchor[] {
  return registry.get(sessionId) ?? [];
}

/** Resolve an anchor by exact turnId, or null when this run never recorded it. */
export function resolveTurnAnchor(sessionId: string, turnId: string): TurnAnchor | null {
  return registry.get(sessionId)?.find((a) => a.turnId === turnId) ?? null;
}

/** Drop a session's anchors. Exposed for tests and session reset. */
export function clearTurnAnchors(sessionId: string): void {
  registry.delete(sessionId);
}

// --- Cross-resume persistence -------------------------------------------------
//
// The TUI mirrors the in-memory registry to a sidecar next to the session file.
// The directory comes off the caller's SessionSurface (`surface.sessionsDir`),
// the same handle the session JSONL itself is written through — so the sidecar
// and its session can never end up in different directories.
const ANCHOR_SIDECAR_VERSION = 1;

/** Absolute path to a session's anchor sidecar, or null when inputs are unusable. */
const ANCHOR_SIDECAR_SUFFIX = '.anchors.json';

function anchorSidecarPath(sessionId: string, surface: SessionSurface): string | null {
  if (!sessionId || !surface.sessionsDir) return null;
  // A sessionId is a filename component; refuse anything with path separators so
  // a malformed id can never escape the sessions directory.
  if (/[\\/]/.test(sessionId)) return null;
  return join(surface.sessionsDir, `${sessionId}${ANCHOR_SIDECAR_SUFFIX}`);
}

function isTurnAnchor(value: unknown): value is TurnAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.turnId === 'string' && a.turnId.length > 0 &&
    typeof a.label === 'string' &&
    typeof a.messageCount === 'number' && Number.isFinite(a.messageCount) &&
    typeof a.at === 'number' && Number.isFinite(a.at)
  );
}

/**
 * Write the current in-memory anchors for a session to its sidecar so they
 * survive a resume. Best-effort and atomic (temp file + rename): a failed or
 * torn write must never break the turn that triggered it. Called after each
 * `recordTurnAnchor` at TURN_COMPLETED.
 */
export function persistTurnAnchors(sessionId: string, surface: SessionSurface): void {
  const path = anchorSidecarPath(sessionId, surface);
  if (!path) return;
  const list = registry.get(sessionId) ?? [];
  if (list.length === 0) return; // nothing to mirror yet
  try {
    mkdirSync(surface.sessionsDir, { recursive: true });
    const payload = JSON.stringify({ version: ANCHOR_SIDECAR_VERSION, sessionId, anchors: list });
    const tmp = `${path}${ANCHOR_SIDECAR_TMP_MARKER}${process.pid}`;
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
  } catch {
    /* best-effort; a rewind-anchor persist miss must never break the turn */
  }
}

/**
 * Reload a session's persisted anchors into the in-memory registry on resume.
 * Returns the number of anchors restored (0 when no sidecar exists or it is
 * unreadable). Idempotent via `recordTurnAnchor`'s per-turnId dedup, so a resume
 * that later re-records the same turn keeps a single entry.
 */
export function restoreTurnAnchors(sessionId: string, surface: SessionSurface): number {
  const path = anchorSidecarPath(sessionId, surface);
  if (!path || !existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { anchors?: unknown };
    if (!parsed || !Array.isArray(parsed.anchors)) return 0;
    let restored = 0;
    for (const candidate of parsed.anchors) {
      if (isTurnAnchor(candidate)) {
        recordTurnAnchor(sessionId, candidate);
        restored++;
      }
    }
    return restored;
  } catch {
    return 0;
  }
}

// ─── Reaping orphaned sidecars ────────────────────────────────────────────────
//
// A sidecar's OWNER is the session JSONL it sits beside. Deleting a session
// removes the JSONL but nothing ever removed the sidecar, so anchors for
// sessions that no longer exist accumulate in the sessions directory forever.
// The sweep below reclaims them, plus the `.tmp-<pid>` staging files a crash
// between write and rename leaves behind.

/** Infix for the atomic-write staging file, before the writing process's pid. */
const ANCHOR_SIDECAR_TMP_MARKER = '.tmp-';

/**
 * How long a staging file is tolerated before it is treated as crash residue:
 * 1 hour. `persistTurnAnchors` renames within microseconds of writing, so
 * anything this old was interrupted, and the completed sidecar (if the write
 * ever finished) is a separate file.
 */
export const ANCHOR_TMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * How settled a sidecar must be before this sweep will delete it: 1 hour.
 *
 * Another instance can be persisting anchors for a session this process knows
 * nothing about, and the window between reading a sidecar's content and
 * unlinking it is not atomic. Requiring the file to have been untouched for an
 * hour means a sidecar that some other instance is actively rewriting is never
 * a candidate, while genuine residue — whose writer is long gone — always is.
 * The sweep repeats, so the delay costs nothing.
 */
export const ANCHOR_SIDECAR_SETTLE_MS = 60 * 60 * 1000;

export interface AnchorSidecarReapResult {
  /** Sidecar and staging files examined this sweep. */
  readonly scanned: number;
  /** Files deleted this sweep. */
  readonly reaped: number;
}

export interface AnchorSidecarReapOptions {
  /** The session this process is using right now; its sidecar is never reaped. */
  readonly currentSessionId?: string | null;
  readonly now?: () => number;
  /** Override the staging-file age window (tests). */
  readonly tmpMaxAgeMs?: number;
  /** Override how long a sidecar must be untouched before it can be reaped (tests). */
  readonly settleMs?: number;
}

/**
 * Delete anchor sidecars whose owning session file is gone, sidecars that hold
 * nothing readable, and abandoned staging files.
 *
 * A sidecar survives when `<sessionsDir>/<sessionId>.jsonl` still exists AND
 * the sidecar itself parses into at least one usable anchor — content, not
 * mere existence, because a sidecar truncated by a crash restores nothing and
 * would otherwise sit there indefinitely looking like valid state. It also
 * survives while it is still fresh (see `ANCHOR_SIDECAR_SETTLE_MS`), which
 * keeps a sidecar another instance is mid-rewrite out of reach.
 *
 * The current session's sidecar is never touched, and an unreadable or absent
 * sessions directory simply reclaims nothing. Idempotent and concurrency-safe:
 * a file another sweeper unlinked first (ENOENT) counts as reaped.
 */
export function reapOrphanedAnchorSidecars(
  surface: SessionSurface,
  options: AnchorSidecarReapOptions = {},
): AnchorSidecarReapResult {
  const dir = surface.sessionsDir;
  if (!dir) return { scanned: 0, reaped: 0 };

  let names: string[];
  try {
    names = readdirSync(dir).filter(
      (n) => n.endsWith(ANCHOR_SIDECAR_SUFFIX) || n.includes(`${ANCHOR_SIDECAR_SUFFIX}${ANCHOR_SIDECAR_TMP_MARKER}`),
    );
  } catch {
    return { scanned: 0, reaped: 0 };
  }

  const now = options.now?.() ?? Date.now();
  const tmpMaxAgeMs = options.tmpMaxAgeMs ?? ANCHOR_TMP_MAX_AGE_MS;
  const settleMs = options.settleMs ?? ANCHOR_SIDECAR_SETTLE_MS;
  let reaped = 0;

  for (const name of names) {
    const path = join(dir, name);

    if (!name.endsWith(ANCHOR_SIDECAR_SUFFIX)) {
      // A `<sessionId>.anchors.json.tmp-<pid>` staging file. Age alone decides:
      // a young one may belong to another instance's in-flight write.
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > tmpMaxAgeMs && unlinkAnchorFile(path)) reaped++;
      continue;
    }

    const sessionId = name.slice(0, name.length - ANCHOR_SIDECAR_SUFFIX.length);
    if (sessionId.length === 0) continue;
    if (options.currentSessionId && sessionId === options.currentSessionId) continue;

    // A sidecar written moments ago belongs to a writer that is still around —
    // possibly another instance whose session this process cannot see.
    let sidecarMtimeMs: number;
    try {
      sidecarMtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - sidecarMtimeMs <= settleMs) continue;

    if (!existsSync(join(dir, `${sessionId}.jsonl`))) {
      // The owning session is gone — this sidecar can never be used again.
      if (unlinkAnchorFile(path)) reaped++;
      continue;
    }
    if (!sidecarHoldsAnchors(path)) {
      // The session survives but the sidecar is empty or torn: it restores
      // nothing, so keeping it only hides the loss.
      if (unlinkAnchorFile(path)) reaped++;
    }
  }

  return { scanned: names.length, reaped };
}

/** Content check: does this sidecar parse into at least one usable anchor? */
function sidecarHoldsAnchors(path: string): boolean {
  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim().length === 0) return false;
    const parsed = JSON.parse(text) as { anchors?: unknown };
    return Array.isArray(parsed?.anchors) && parsed.anchors.some(isTurnAnchor);
  } catch {
    return false;
  }
}

function unlinkAnchorFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  }
}
