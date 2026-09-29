/**
 * lane-graph/layout.ts, where every lane of a turn's work tree sits, row by
 * row.
 *
 * A turn is drawn the way `git log --graph` draws history: the turn's own
 * work is a vertical SPINE, a subagent (or a WRFC chain, or a hosted agent)
 * BRANCHES off the lane that started it into a lane of its own, its tool
 * calls are beads on that lane, and it MERGES back into exactly the lane it
 * came from. Lanes that run at the same time sit side by side.
 *
 * Input: the turn's rows in display order, each described only by what it
 * does to the lanes (see LaneEvent). Output: one gutter row per event, made
 * of drawing ROLES (glyphs.ts turns a role into a character), plus the
 * continuation gutter that runs beside anything drawn under that row (wrapped
 * text, an opened bead's body).
 *
 * Geometry: every lane is 2 columns wide, the lane line on the even column,
 * the odd column free for horizontal runs. A new lane takes the lowest free
 * slot to the right of its parent, so a child is always right of its parent
 * and lanes never move sideways once placed. The text column is fixed for the
 * whole turn (see gutterWidthFor) so text never shifts with depth.
 *
 * Everything here is pure: no theme, no width, no glyph set.
 */

import type { LaneGlyphRole } from './glyphs.ts';

export type LaneId = string;

/** The turn's own lane. */
export const SPINE: LaneId = 'spine';

export type LaneEvent =
  /** The turn header: the spine opens with ╭─. */
  | { readonly kind: 'head' }
  /** A folded turn's header: a single ◆, no lane opens. */
  | { readonly kind: 'turn' }
  /** A row with no mark of its own (text): every live lane runs past it. */
  | { readonly kind: 'row' }
  /** A tool call on `lane`: its bead sits on the lane. */
  | { readonly kind: 'bead'; readonly lane: LaneId }
  /** A finished lane folded to one ◉ bead on its parent's lane, in its own color. */
  | { readonly kind: 'folded'; readonly lane: LaneId; readonly child: LaneId }
  /** `lane` branches off `parent` (├─╮). */
  | { readonly kind: 'spawn'; readonly parent: LaneId; readonly lane: LaneId }
  /** `lane` merges back into the lane it came from (├─╯). */
  | { readonly kind: 'merge'; readonly lane: LaneId }
  /** The answer's first row: the spine closes with ╰─. */
  | { readonly kind: 'answer' };

/** One drawn cell of a gutter row. `color` is the lane's color index (creation order). */
export interface GutterCell {
  readonly role: LaneGlyphRole | 'bead';
  readonly color: number;
}

export type GutterRow = ReadonlyArray<GutterCell | null>;

export interface LaneLayout {
  /** One gutter row per input event. */
  readonly rows: readonly GutterRow[];
  /** The gutter under each event's row: every lane still live after it, as │. */
  readonly cont: readonly GutterRow[];
  /** Column (within the gutter) of the row's bead, ◉, ◆ or the lane end the row is about. */
  readonly markCol: ReadonlyArray<number | undefined>;
  /** Most lanes live at once anywhere in the turn. */
  readonly maxLive: number;
  /** Highest slot used + 1. */
  readonly slots: number;
  /** Columns from the gutter's first column to the turn's text column. */
  readonly gutterWidth: number;
  /** Color index of every lane that appeared. */
  readonly laneColor: ReadonlyMap<LaneId, number>;
}

/**
 * Columns from the gutter's first column to the text column: 6 while one lane
 * is live, 10 for up to four, and two more per lane past that. Fixed per turn
 * so a turn's text starts in one column however deep its lanes go.
 */
function gutterWidthFor(slots: number): number {
  if (slots <= 1) return 6;
  if (slots <= 4) return 10;
  return slots * 2 + 2;
}

interface LaneState {
  readonly id: LaneId;
  readonly parent: LaneId | undefined;
  readonly slot: number;
  readonly color: number;
  live: boolean;
}

export function layoutLaneGraph(events: readonly LaneEvent[]): LaneLayout {
  const lanes = new Map<LaneId, LaneState>();
  const bySlot: Array<LaneState | undefined> = [];
  let nextColor = 0;
  let maxLive = 0;
  let maxSlot = -1;

  const colorOf = (id: LaneId): number => {
    const known = lanes.get(id);
    if (known) return known.color;
    return nextColor++;
  };

  const liveCount = (): number => bySlot.filter((l) => l?.live).length;

  const openLane = (id: LaneId, parent: LaneId | undefined, minSlot: number): LaneState => {
    let slot = Math.max(0, minSlot);
    while (bySlot[slot]?.live) slot++;
    const state: LaneState = { id, parent, slot, color: colorOf(id), live: true };
    lanes.set(id, state);
    bySlot[slot] = state;
    maxSlot = Math.max(maxSlot, slot);
    maxLive = Math.max(maxLive, liveCount());
    return state;
  };

  /** A lane an event names but that never opened (defensive): open it off the spine. */
  const ensureLane = (id: LaneId): LaneState => {
    const known = lanes.get(id);
    if (known && known.live) return known;
    if (id === SPINE) return openLane(SPINE, undefined, 0);
    const parent = lanes.get(SPINE);
    return openLane(id, SPINE, (parent?.live ? parent.slot : -1) + 1);
  };

  /** The nearest ancestor of `lane` that is still live. */
  const openAncestor = (lane: LaneState): LaneState | undefined => {
    let cursor = lane.parent !== undefined ? lanes.get(lane.parent) : undefined;
    while (cursor && !cursor.live) cursor = cursor.parent !== undefined ? lanes.get(cursor.parent) : undefined;
    return cursor;
  };

  /** A row of │ for every live lane. */
  const baseRow = (): Array<GutterCell | null> => {
    const row: Array<GutterCell | null> = [];
    bySlot.forEach((lane, slot) => {
      if (lane?.live) row[slot * 2] = { role: 'vert', color: lane.color };
    });
    return row;
  };

  /** Draw a horizontal run from slot `from` (exclusive) to slot `to` (exclusive), in `color`. */
  const run = (row: Array<GutterCell | null>, from: number, to: number, color: number): void => {
    for (let col = from * 2 + 1; col < to * 2; col++) {
      const lane = col % 2 === 0 ? bySlot[col / 2] : undefined;
      row[col] = lane?.live ? { role: 'cross', color: lane.color } : { role: 'horiz', color };
    }
  };

  const rows: GutterRow[] = [];
  const cont: GutterRow[] = [];
  const markCol: Array<number | undefined> = [];

  for (const event of events) {
    let row: Array<GutterCell | null>;
    let mark: number | undefined;
    switch (event.kind) {
      case 'head': {
        const spine = lanes.get(SPINE)?.live ? lanes.get(SPINE)! : openLane(SPINE, undefined, 0);
        row = baseRow();
        row[spine.slot * 2] = { role: 'head', color: spine.color };
        row[spine.slot * 2 + 1] = { role: 'horiz', color: spine.color };
        mark = spine.slot * 2;
        break;
      }
      case 'turn': {
        const color = colorOf(SPINE);
        if (!lanes.has(SPINE)) lanes.set(SPINE, { id: SPINE, parent: undefined, slot: 0, color, live: false });
        row = baseRow();
        row[0] = { role: 'turn', color };
        maxSlot = Math.max(maxSlot, 0);
        maxLive = Math.max(maxLive, 1);
        mark = 0;
        break;
      }
      case 'row': {
        row = baseRow();
        break;
      }
      case 'bead': {
        const lane = ensureLane(event.lane);
        row = baseRow();
        row[lane.slot * 2] = { role: 'bead', color: lane.color };
        mark = lane.slot * 2;
        break;
      }
      case 'folded': {
        const parent = ensureLane(event.lane);
        const color = colorOf(event.child);
        if (!lanes.has(event.child)) lanes.set(event.child, { id: event.child, parent: event.lane, slot: parent.slot, color, live: false });
        row = baseRow();
        row[parent.slot * 2] = { role: 'folded', color };
        mark = parent.slot * 2;
        break;
      }
      case 'spawn': {
        const parent = ensureLane(event.parent);
        row = baseRow();
        const child = openLane(event.lane, event.parent, parent.slot + 1);
        row[parent.slot * 2] = { role: 'branch', color: parent.color };
        run(row, parent.slot, child.slot, child.color);
        row[child.slot * 2] = { role: 'open', color: child.color };
        mark = child.slot * 2;
        break;
      }
      case 'merge': {
        const lane = lanes.get(event.lane);
        row = baseRow();
        if (!lane || !lane.live) break;
        const target = openAncestor(lane);
        if (target) {
          row[target.slot * 2] = { role: 'branch', color: target.color };
          run(row, target.slot, lane.slot, lane.color);
          row[lane.slot * 2] = { role: 'merge', color: lane.color };
        } else {
          // Nothing left to merge into (its parents already ended): the lane just ends.
          row[lane.slot * 2] = { role: 'close', color: lane.color };
        }
        mark = lane.slot * 2;
        lane.live = false;
        break;
      }
      case 'answer': {
        const spine = lanes.get(SPINE);
        row = baseRow();
        const slot = spine?.slot ?? 0;
        const color = spine?.color ?? colorOf(SPINE);
        row[slot * 2] = { role: 'close', color };
        row[slot * 2 + 1] = { role: 'horiz', color };
        if (spine) spine.live = false;
        mark = slot * 2;
        break;
      }
    }
    rows.push(row);
    cont.push(baseRow());
    markCol.push(mark);
  }

  const slots = maxSlot + 1;
  const laneColor = new Map<LaneId, number>();
  for (const [id, lane] of lanes) laneColor.set(id, lane.color);
  return { rows, cont, markCol, maxLive, slots, gutterWidth: gutterWidthFor(slots), laneColor };
}
