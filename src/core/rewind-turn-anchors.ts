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
 * Scope + lifetime: in-memory, keyed by sessionId, populated for the CURRENT
 * process run only. Turns from a resumed prior session (whose turnIds predate
 * this run) are not present — an honest limitation surfaced by /rewind, which
 * offers exactly the anchors recorded here rather than inventing boundaries.
 */

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
