// ---------------------------------------------------------------------------
// fleet-stop.ts
//
// d1 (W6.2) — the "stopping…" write-window overlay, split out of fleet-panel.ts
// to keep that file under the architecture 800-line gate (same rationale as
// fleet-steer.ts). FleetPanel owns nothing here beyond a FleetStopTracker
// instance; all the state->display logic lives in these pure helpers.
// ---------------------------------------------------------------------------

import type { ProcessNode, ProcessState } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { fleetStateGlyph, fleetStateTone, isTerminalProcessState, type FleetStateTone, type FleetTreeRow } from './fleet-read-model.ts';

/** How long 'stopping…' lingers after a stop keypress before the true state is shown regardless (never masks a stuck kill). */
export const STOP_SETTLE_MS = 1500;
/** Display-only glyph for a node with an in-flight stop request. Verified free against STATE_GLYPHS (fleet-read-model.ts) and width-1 like its ⊘/⊟ siblings. */
export const STOPPING_GLYPH = '⊗';

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

export function fleetStateDisplay(state: ProcessState, stopping: boolean): FleetStateDisplay {
  return stopping
    ? { glyph: STOPPING_GLYPH, label: 'stopping…', tone: 'warn' }
    : { glyph: fleetStateGlyph(state), label: state, tone: fleetStateTone(state) };
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
 * d2 (W6.2): 'p' toggles pause<->resume by the node's state. A `paused`
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
): FleetHint[] {
  const live = selected !== undefined && !isTerminalProcessState(selected.state);
  const isPaused = selected !== undefined && selected.state === 'paused';
  const hints: FleetHint[] = [
    { keys: 'j/k', label: 'navigate' },
    { keys: 'Enter', label: 'attach' },
  ];
  if (live && selected.capabilities.interruptible) hints.push({ keys: 'i', label: 'interrupt' });
  if (live && selected.capabilities.killable) hints.push({ keys: 'K', label: 'kill' });
  if (live && !isPaused && selected.capabilities.pausable) hints.push({ keys: 'p', label: 'pause' });
  if (isPaused && selected.capabilities.resumable) hints.push({ keys: 'p', label: 'resume' });
  hints.push({ keys: 'f', label: follow ? 'follow:on' : 'follow' });
  if (hasTabs) hints.push({ keys: '[ ]', label: 'tabs' });
  return hints;
}

/** K-confirm descendant stats (UX-C item 6): total = every non-terminal descendant (what a cascade kill takes down); active = the individually-killable subset. Was "active only" (Wave-3 C7), undercounting a mixed subtree. */
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
