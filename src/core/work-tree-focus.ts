/**
 * work-tree-focus.ts, moving the keyboard through the work tree.
 *
 * The navigable rows are the blocks the work tree registered with a
 * `workTree` field: turn headers, beads, and agent lanes (their spawn or
 * folded row), in screen order. Keys:
 *
 *   ↑ ↓     previous / next row
 *   ←       fold: close an open body; on a lane's bead or spawn row fold the
 *           lane to one ◉; on the spine fold the turn to its header
 *   →       unfold: open a body (a second → shows the rest of a capped
 *           body); unfold a folded lane or turn
 *   Enter   open or close a bead's body; unfold a folded lane; fold or
 *           unfold a turn
 *
 * Pure: reads the registry and collapse state, returns the collapse changes
 * and the row to focus next. Nothing here stops, cancels or sends anything.
 */

import type { BlockMeta } from './conversation-types.ts';
import type { TurnOutcome } from './work-tree-sources.ts';

/** A turn's saved ending: the user message it answered (by index and fingerprint) and how it ended. */
export interface TurnOutcomeRecord {
  readonly index: number;
  readonly fingerprint: string;
  readonly outcome: TurnOutcome;
}

/** Most turn endings kept per session. */
export const MAX_TURN_OUTCOMES = 500;

export type NavBlock = BlockMeta & { readonly workTree: NonNullable<BlockMeta['workTree']> };

export interface FocusChange {
  /** Collapse keys to set (true = folded / closed). */
  readonly set: ReadonlyArray<readonly [string, boolean]>;
  /** The row to focus afterwards. */
  readonly focus: string;
}

/** Navigable rows in screen order. */
export function navigableRows(blocks: readonly BlockMeta[]): NavBlock[] {
  return blocks.filter((b): b is NavBlock => b.workTree !== undefined).sort((a, b) => a.startLine - b.startLine);
}

export function findRow(blocks: readonly BlockMeta[], id: string): NavBlock | undefined {
  return navigableRows(blocks).find((b) => b.workTree.id === id);
}

/** The row to focus on entering the work tree: the last one at or above `anchorLine` (else the last row). */
export function initialFocus(blocks: readonly BlockMeta[], anchorLine: number): string | null {
  const rows = navigableRows(blocks);
  if (rows.length === 0) return null;
  const above = rows.filter((b) => b.startLine <= anchorLine);
  return (above[above.length - 1] ?? rows[rows.length - 1]!).workTree.id;
}

/** The row `delta` rows from `current` (clamped); null when there are none. */
export function moveFocus(blocks: readonly BlockMeta[], current: string | null, delta: number): string | null {
  const rows = navigableRows(blocks);
  if (rows.length === 0) return null;
  const at = current === null ? -1 : rows.findIndex((b) => b.workTree.id === current);
  if (at < 0) return rows[delta < 0 ? rows.length - 1 : 0]!.workTree.id;
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))]!.workTree.id;
}

/** The turn header a row belongs to (the nearest turn row above it). */
function turnOf(blocks: readonly BlockMeta[], row: NavBlock): NavBlock | undefined {
  const rows = navigableRows(blocks).filter((b) => b.workTree.kind === 'turn' && b.startLine <= row.startLine);
  return rows[rows.length - 1];
}

function laneRow(blocks: readonly BlockMeta[], laneKey: string): NavBlock | undefined {
  return navigableRows(blocks).find((b) => b.workTree.kind === 'lane' && b.workTree.laneKey === laneKey);
}

/** ← on the focused row. */
export function foldFocused(blocks: readonly BlockMeta[], id: string): FocusChange | null {
  const row = findRow(blocks, id);
  if (!row) return null;
  const wt = row.workTree;
  if (wt.kind === 'bead') {
    if (wt.open) return { set: [[row.collapseKey, true], ...(wt.moreKey ? [[wt.moreKey, false] as const] : [])], focus: id };
    if (wt.laneKey) {
      const lane = laneRow(blocks, wt.laneKey);
      return { set: [[wt.laneKey, true]], focus: lane?.workTree.id ?? wt.laneKey };
    }
    const turn = turnOf(blocks, row);
    return turn ? { set: [[turn.collapseKey, true]], focus: turn.workTree.id } : null;
  }
  if (wt.kind === 'lane') {
    if (wt.open) return { set: [[row.collapseKey, true]], focus: id };
    const turn = turnOf(blocks, row);
    return turn ? { set: [[turn.collapseKey, true]], focus: turn.workTree.id } : null;
  }
  return wt.open ? { set: [[row.collapseKey, true]], focus: id } : null;
}

/** → on the focused row. */
export function unfoldFocused(blocks: readonly BlockMeta[], id: string): FocusChange | null {
  const row = findRow(blocks, id);
  if (!row) return null;
  const wt = row.workTree;
  if (wt.kind === 'bead') {
    if (!wt.hasBody) return null;
    if (!wt.open) return { set: [[row.collapseKey, false]], focus: id };
    if (wt.capped && wt.moreKey) return { set: [[wt.moreKey, true]], focus: id };
    return null;
  }
  return wt.open ? null : { set: [[row.collapseKey, false]], focus: id };
}

/** Enter on the focused row. */
export function activateFocused(blocks: readonly BlockMeta[], id: string): FocusChange | null {
  const row = findRow(blocks, id);
  if (!row) return null;
  const wt = row.workTree;
  if (wt.kind === 'bead') {
    if (!wt.hasBody) return null;
    return wt.open ? { set: [[row.collapseKey, true]], focus: id } : { set: [[row.collapseKey, false]], focus: id };
  }
  if (wt.kind === 'lane') return wt.open ? null : { set: [[row.collapseKey, false]], focus: id };
  return { set: [[row.collapseKey, wt.open]], focus: id };
}

export interface WorkTreeControllerDeps {
  /** The current block registry (flushed). */
  readonly blocks: () => readonly BlockMeta[];
  readonly collapseState: () => Map<string, boolean>;
  readonly markDirty: () => void;
  /** Exempts a key from search's close-time auto re-collapse (a deliberate user act). */
  readonly noteUserTouch: (key: string) => void;
  /** Whether the last build drew something live. */
  readonly drewLive: () => boolean;
}

/** Collapse keys the work tree owns (work-tree-model.ts). */
const FOLD_KEY = /^(turn_\d+|bead_|beadmore_|lane_)/;

/**
 * The work tree's keyboard focus, live repaint tick and fold state, owned by a
 * ConversationManager (as `conversation.workTree`).
 */
export class WorkTreeController {
  private focusId: string | null = null;
  private liveFrame = 0;
  private foldListener: (() => void) | null = null;
  /** Failed and cancelled turn endings of this session, by user message index. */
  private readonly outcomes = new Map<number, TurnOutcomeRecord>();
  private readonly resetListeners = new Set<() => void>();

  constructor(private readonly deps: WorkTreeControllerDeps) {}

  /** The focused row id, or null while the keyboard is in the composer. */
  get focus(): string | null { return this.focusId; }
  /** Spinner frame for running beads. */
  get frame(): number { return this.liveFrame; }
  get focused(): boolean { return this.focusId !== null; }

  /**
   * The transcript was reset or replaced wholesale (a new or resumed session):
   * focus, turn endings and anything keyed by message index belong to the old
   * transcript and go.
   */
  reset(): void {
    this.focusId = null;
    this.outcomes.clear();
    for (const listener of this.resetListeners) listener();
  }

  /** Be told when the transcript is reset (the timing store keys turns by message index). */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  }

  /**
   * Record how a turn ended. Only failed and cancelled endings are kept (a
   * completed turn is the default and says nothing extra). Returns whether the
   * kept records changed.
   */
  recordTurnOutcome(record: TurnOutcomeRecord): boolean {
    const had = this.outcomes.delete(record.index);
    if (record.outcome === 'completed') return had;
    this.outcomes.set(record.index, record);
    while (this.outcomes.size > MAX_TURN_OUTCOMES) {
      const oldest = this.outcomes.keys().next();
      if (oldest.done) break;
      this.outcomes.delete(oldest.value);
    }
    this.deps.markDirty();
    return true;
  }

  /** The recorded ending of the turn answering the user message at `index`. */
  turnOutcome(index: number): TurnOutcomeRecord | undefined {
    return this.outcomes.get(index);
  }

  /** Every recorded turn ending, oldest first (the session sidecar keeps them). */
  turnOutcomes(): TurnOutcomeRecord[] {
    return [...this.outcomes.values()];
  }

  /** Restore saved turn endings (a resumed session keeps its failed and cancelled headers). */
  restoreTurnOutcomes(records: Iterable<TurnOutcomeRecord>): void {
    for (const record of records) this.recordTurnOutcome(record);
    this.deps.markDirty();
  }

  /** Something the work tree draws changed outside the transcript (a ◈ summary landed): rebuild. */
  invalidate(): void { this.deps.markDirty(); }

  /** Be told when a fold decision changes (the session keeps them in its sidecar). */
  onFoldChange(listener: (() => void) | null): void { this.foldListener = listener; }
  notifyFoldChange(): void { this.foldListener?.(); }

  /**
   * Repaint live rows as time passes (a running bead spins, its time counts
   * up). Call before each frame; it marks the transcript dirty only while the
   * last build drew something live and the frame moved on.
   */
  tickLive(now = Date.now()): void {
    const frame = Math.floor(now / 150);
    if (frame === this.liveFrame) return;
    this.liveFrame = frame;
    if (this.deps.drewLive()) this.deps.markDirty();
  }

  /** Enter the work tree at the last row at or above `anchorLine`; false when there is nothing to focus. */
  enter(anchorLine: number): boolean {
    const id = initialFocus(this.deps.blocks(), anchorLine);
    if (id === null) return false;
    this.focusId = id;
    this.deps.markDirty();
    return true;
  }

  /** Leave the work tree (Esc). Never stops or cancels anything. */
  leave(): void {
    if (this.focusId === null) return;
    this.focusId = null;
    this.deps.markDirty();
  }

  move(delta: number): boolean {
    const next = moveFocus(this.deps.blocks(), this.focusId, delta);
    if (next === null || next === this.focusId) return false;
    this.focusId = next;
    this.deps.markDirty();
    return true;
  }

  /** ← (fold), → (unfold) or Enter (activate) on the focused row. */
  act(action: 'fold' | 'unfold' | 'activate'): boolean {
    if (this.focusId === null) return false;
    const blocks = this.deps.blocks();
    const change = action === 'fold' ? foldFocused(blocks, this.focusId)
      : action === 'unfold' ? unfoldFocused(blocks, this.focusId)
        : activateFocused(blocks, this.focusId);
    if (!change) return false;
    const collapse = this.deps.collapseState();
    for (const [key, value] of change.set) {
      collapse.set(key, value);
      this.deps.noteUserTouch(key);
    }
    this.focusId = change.focus;
    this.deps.markDirty();
    this.foldListener?.();
    return true;
  }

  /** The focused row's block (copy, save and bookmark act on it). */
  focusBlock(): BlockMeta | null {
    return this.focusId === null ? null : findRow(this.deps.blocks(), this.focusId) ?? null;
  }

  /** Every work-tree fold decision (turns, lanes, open beads), oldest first. */
  foldState(): Array<[string, boolean]> {
    return [...this.deps.collapseState()].filter(([key]) => FOLD_KEY.test(key));
  }

  /** Restore saved fold decisions (a resumed session keeps its view). */
  restoreFoldState(entries: Iterable<readonly [string, boolean]>): void {
    const collapse = this.deps.collapseState();
    for (const [key, value] of entries) if (FOLD_KEY.test(key)) collapse.set(key, value);
    this.deps.markDirty();
  }
}
