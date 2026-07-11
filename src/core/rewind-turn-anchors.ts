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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';

const { getUserSessionsDir } = operations;

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
// Surface is always 'tui' (the sessions the TUI reads/writes live under the same
// scoped directory), matching how the session JSONL itself is persisted.
const ANCHOR_SIDECAR_SURFACE = 'tui';
const ANCHOR_SIDECAR_VERSION = 1;

/** Absolute path to a session's anchor sidecar, or null when inputs are unusable. */
function anchorSidecarPath(sessionId: string, workingDirectory: string): string | null {
  if (!sessionId || !workingDirectory) return null;
  // A sessionId is a filename component; refuse anything with path separators so
  // a malformed id can never escape the sessions directory.
  if (/[\\/]/.test(sessionId)) return null;
  return join(getUserSessionsDir(workingDirectory, ANCHOR_SIDECAR_SURFACE), `${sessionId}.anchors.json`);
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
export function persistTurnAnchors(sessionId: string, workingDirectory: string): void {
  const path = anchorSidecarPath(sessionId, workingDirectory);
  if (!path) return;
  const list = registry.get(sessionId) ?? [];
  if (list.length === 0) return; // nothing to mirror yet
  try {
    mkdirSync(getUserSessionsDir(workingDirectory, ANCHOR_SIDECAR_SURFACE), { recursive: true });
    const payload = JSON.stringify({ version: ANCHOR_SIDECAR_VERSION, sessionId, anchors: list });
    const tmp = `${path}.tmp-${process.pid}`;
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
export function restoreTurnAnchors(sessionId: string, workingDirectory: string): number {
  const path = anchorSidecarPath(sessionId, workingDirectory);
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
