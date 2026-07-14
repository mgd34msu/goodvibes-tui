// ---------------------------------------------------------------------------
// fleet-stop.ts
//
// d1 — the "stopping…" write-window overlay, split out of fleet-panel.ts
// to keep that file under the architecture 800-line gate (same rationale as
// fleet-steer.ts). FleetPanel owns nothing here beyond a FleetStopTracker
// instance; all the state->display logic lives in these pure helpers.
// ---------------------------------------------------------------------------

import type { ProcessNode, ProcessState } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { WorkItem } from '@pellux/goodvibes-sdk/platform/orchestration';
import { fleetNodeAttention, fleetStateGlyph, fleetStateTone, isTerminalProcessState, type FleetStateTone, type FleetTreeRow } from './fleet-read-model.ts';

/** True when a work-item node owns a worktree that worktrees.discard can act on (D from the tree). */
function ownsWorktree(node: ProcessNode): boolean {
  return Boolean((node.raw as { item?: WorkItem } | undefined)?.item?.worktreePath);
}

/** How long 'stopping…' lingers after a stop keypress before the true state is shown regardless (never masks a stuck kill). */
export const STOP_SETTLE_MS = 1500;
/** Display-only glyph for a node with an in-flight stop request. Verified free against STATE_GLYPHS (fleet-read-model.ts) and width-1 like its ⊘/⊟ siblings. */
export const STOPPING_GLYPH = '⊗';
/** Display-only glyph for a node blocked on the user (awaiting your approval/input). Verified free against STATE_GLYPHS + STOPPING_GLYPH and width-1. */
export const BLOCKED_GLYPH = '⚑';

/**
 * Tracks node ids the operator just asked to stop (kill/interrupt/pause) mapped
 * to the keypress time. While an id is present AND within STOP_SETTLE_MS its row
 * renders a display-only 'stopping…' instead of the raw state — so the tree
 * never claims the past-tense 'killed'/'interrupted' during the brief write
 * window between the keypress and the state actually flipping. After the settle
 * window the TRUE state is ALWAYS shown, so a genuinely stuck kill is never
 * masked. 'stopping…' is NOT a ProcessState; it lives only here.
 */
export class FleetStopTracker {
  private readonly requestedAt = new Map<string, number>();

  /** Record a stop request for `id` (kill/interrupt/pause). */
  mark(id: string, now: number = Date.now()): void {
    this.requestedAt.set(id, now);
  }

  /** Drop any stop request for `id` (e.g. a resume, which is a start not a stop). */
  clear(id: string): void {
    this.requestedAt.delete(id);
  }

  /** True while `id` has an in-flight stop request inside the settle window. Prunes expired markers so the map stays bounded and stuck kills are never masked past the window. */
  isStopping(id: string, now: number = Date.now()): boolean {
    const at = this.requestedAt.get(id);
    if (at === undefined) return false;
    if (now - at < STOP_SETTLE_MS) return true;
    this.requestedAt.delete(id);
    return false;
  }
}

/** Glyph + literal label + tone for a node, applying the display-only 'stopping…' override while a stop is in flight. */
export interface FleetStateDisplay {
  readonly glyph: string;
  readonly label: string;
  readonly tone: FleetStateTone;
}

/**
 * Glyph/label/tone for a row, applying two display-only overrides in priority
 * order: an in-flight stop ('stopping…') wins first (a node the operator just
 * asked to stop is no longer meaningfully "blocked on you"), then a
 * blocked-on-user node gets the distinct ⚑ badge + 'blocked on you' label so it
 * reads as needing the operator, not as an anonymous 'awaiting-approval'. Both
 * are display-only; neither is a ProcessState.
 */
export function fleetStateDisplay(state: ProcessState, stopping: boolean, blocked = false): FleetStateDisplay {
  if (stopping) return { glyph: STOPPING_GLYPH, label: 'stopping…', tone: 'warn' };
  if (blocked) return { glyph: BLOCKED_GLYPH, label: 'blocked on you', tone: 'warn' };
  return { glyph: fleetStateGlyph(state), label: state, tone: fleetStateTone(state) };
}

/** The narrow action + side-effect surface `toggleFleetPause` needs from FleetPanel. */
export interface FleetPauseDeps {
  readonly interrupt: (id: string) => boolean;
  readonly resume: (id: string) => boolean;
  readonly setError: (message: string) => void;
  readonly markDirty: () => void;
  readonly tracker: FleetStopTracker;
}

/**
 * d2: 'p' toggles pause<->resume by the node's state. A `paused`
 * resumable node is resumed (interrupt's inverse); a live pausable node is
 * paused via the registry's interrupt() (its disable path). Honest refusal for
 * non-resumable/non-pausable kinds. Returns true when the key is consumed,
 * false to fall through (terminal, non-paused node — nothing to toggle).
 */
export function toggleFleetPause(node: ProcessNode, deps: FleetPauseDeps): boolean {
  if (node.state === 'paused') {
    if (!node.capabilities.resumable) { deps.setError(`${node.kind} cannot be resumed.`); return true; }
    deps.resume(node.id);
    deps.tracker.clear(node.id); // a resume is a start, not a stop
    deps.markDirty();
    return true;
  }
  if (isTerminalProcessState(node.state)) return false;
  if (!node.capabilities.pausable) { deps.setError(`${node.kind} does not support pause.`); return true; }
  deps.interrupt(node.id);
  deps.tracker.mark(node.id);
  deps.markDirty();
  return true;
}

/** A single keyboard-hint chip in the fleet tree footer. */
export interface FleetHint {
  readonly keys: string;
  readonly label: string;
}

/**
 * Build the fleet tree footer hints for the current selection. Capability gates
 * mirror the handleInput guards: interrupt/kill only on a live capable node;
 * 'p' shows 'pause' for a live pausable node and 'resume' for a paused resumable
 * one (never both, d2).
 */
export function buildFleetTreeHints(
  selected: ProcessNode | undefined,
  follow: boolean,
  hasTabs: boolean,
  viewMode: 'active' | 'archived' = 'active',
  blockedCount = 0,
): FleetHint[] {
  const live = selected !== undefined && !isTerminalProcessState(selected.state);
  const isPaused = selected !== undefined && selected.state === 'paused';
  // Enter is context-sensitive: on a flagged pick/conflict row it acts, else it
  // attaches. Name the act so the key is discoverable from the tree.
  const attention = selected ? fleetNodeAttention(selected) : null;
  const enterLabel = attention?.reason === 'pick' ? 'pick'
    : attention?.reason === 'conflict' ? 'resolve conflict'
      : 'attach';
  const hints: FleetHint[] = [
    { keys: 'j/k', label: 'navigate' },
    { keys: 'Enter', label: enterLabel },
  ];
  // Jump-to-blocked is offered whenever something is waiting on the operator,
  // in either view (the blocked nodes live in the active fleet, and the jump
  // switches back to it) — so it is placed before the view-specific branch.
  if (blockedCount > 0) hints.push({ keys: 'b', label: `blocked (${blockedCount})` });
  if (viewMode === 'archived') {
    // Archive view: restore + return to the live fleet; nothing here is live,
    // so the live-only control hints (s/i/K/p) never apply.
    if (selected) hints.push({ keys: 'a', label: 'restore' });
    hints.push({ keys: 'v', label: 'live view' });
    if (hasTabs) hints.push({ keys: '[ ]', label: 'tabs' });
    return hints;
  }
  if (live && selected.capabilities.steerable) hints.push({ keys: 's', label: 'steer' }); // discoverable from the tree (attach-and-steer)
  if (live && selected.capabilities.interruptible) hints.push({ keys: 'i', label: 'interrupt' });
  if (live && selected.capabilities.killable) hints.push({ keys: 'K', label: 'kill' });
  if (live && !isPaused && selected.capabilities.pausable) hints.push({ keys: 'p', label: 'pause' });
  if (isPaused && selected.capabilities.resumable) hints.push({ keys: 'p', label: 'resume' });
  if (selected && ownsWorktree(selected)) hints.push({ keys: 'D', label: 'discard worktree' });
  if (selected && !live) hints.push({ keys: 'a', label: 'archive' });
  hints.push({ keys: 'A', label: 'archive finished' });
  hints.push({ keys: 'v', label: 'archived' });
  hints.push({ keys: 'n', label: 'host agent' });
  hints.push({ keys: 'f', label: follow ? 'follow:on' : 'follow' });
  if (hasTabs) hints.push({ keys: '[ ]', label: 'tabs' });
  return hints;
}

/** K-confirm descendant stats (item 6): total = every non-terminal descendant (what a cascade kill takes down); active = the individually-killable subset. Was "active only" in an earlier version, undercounting a mixed subtree. */
export function countDescendantStats(rows: readonly FleetTreeRow[], nodeId: string): { total: number; active: number } {
  const byParent = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.node.parentId) continue;
    const siblings = byParent.get(row.node.parentId) ?? [];
    siblings.push(row.node.id);
    byParent.set(row.node.parentId, siblings);
  }
  const byId = new Map(rows.map((row) => [row.node.id, row] as const));
  let total = 0, active = 0;
  const stack = [...(byParent.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (row && !isTerminalProcessState(row.node.state)) {
      total++;
      if (row.node.capabilities.killable) active++;
    }
    for (const child of byParent.get(id) ?? []) stack.push(child);
  }
  return { total, active };
}

/**
 * Build the confirm-overlay arm options for a cascade Kill of one node — the
 * label carries the descendant count so the operator sees what a confirm takes
 * down. Extracted from FleetPanel to keep that file under the 800-line cap.
 */
export function fleetKillConfirmArgs(
  node: ProcessNode,
  items: readonly FleetTreeRow[],
  deps: { readonly kill: (id: string) => void; readonly markStopping: (id: string) => void },
): { id: string; label: string; verb: string; onConfirm: () => void } {
  const shortId = node.id.length > 8 ? node.id.slice(-8) : node.id;
  const stats = countDescendantStats(items, node.id);
  const suffix = stats.total > 0 ? ` (+${stats.total} descendant${stats.total === 1 ? '' : 's'}, ${stats.active} active)` : '';
  return {
    id: node.id,
    label: `${node.kind} ${shortId}${suffix}`,
    verb: 'Kill',
    // Mark 'stopping…' only once the kill is confirmed, not while merely armed.
    onConfirm: () => { deps.kill(node.id); deps.markStopping(node.id); },
  };
}
