/**
 * conversation-tree.ts — column geometry for the transcript's branch tree.
 *
 * The transcript renders an assistant turn as a small tree: the turn header at
 * depth 0, each tool call it issues as a depth-1 branch, and each call's result
 * as a depth-2 branch under that call. This module owns the *only* arithmetic
 * that decides where those branch glyphs, status markers and row text land, so
 * every row type (event lines, tool-call rows, collapsed fragments) agrees on a
 * single column grid instead of each re-deriving it.
 *
 * ## The grid
 *
 * One function generates every column, from LAYOUT.LEFT_MARGIN and the row's
 * depth. With LEFT_MARGIN = 4 and TREE_STEP_COLS = 2 that is:
 *
 *   depth 0   `   ●  assistant …`            marker col 3, text col 6
 *   depth 1   `   ✓  ├ read  foo.ts`         marker col 3, connector col 5, text col 8
 *   depth 2   `      │ └  ▸ 31 lines`        connector col 7, text col 10
 *   depth 3   `      │   │ └  …`             connector col 9, text col 12
 *
 * A level's connector sits where its parent's content began, and the row's
 * first printable character sits two columns further right — the same
 * marker→text relationship a depth-0 row has. So the step between levels is
 * exactly TREE_STEP_COLS at every depth, for every row type.
 *
 * ## The status column IS the bullet column
 *
 * `treeStatusCol()` is defined as `treeBranchCol(0)` — literally the column the
 * `●` of `● assistant` occupies. A tool row's ✓ / ✗ / ⊘ / ◌ therefore lands in
 * the same column as the bullet of the turn that issued it, and reads as that
 * bullet's column continuing down the turn rather than as a separate rail off
 * to the left. Deriving it from treeBranchCol rather than restating a number is
 * what keeps the two from drifting: move the bullet and the markers follow.
 *
 * The column is free at every depth ≥ 1 by construction — a branch row's own
 * marker moves right with its indent, and depth 0 never contributes a `│`
 * gutter (a top-level row has no ancestor to continue), so nothing else can
 * claim it.
 *
 * ## Rails are continuous
 *
 * `drawTreeRails` paints EVERY line a row emits, not just its first: the
 * connector on line 0, then `│` down the row's own column for as long as the
 * row has a sibling below it, plus `│` in each open ancestor's gutter on every
 * line. That is what closes the gaps a first-line-only connector leaves under
 * multi-line rows (collapsed fragment boxes, wrapped text, expanded bodies).
 *
 * Rails never overwrite text: apart from the connector itself — which
 * deliberately replaces the marker cell of the row it labels — a rail is drawn
 * only into a cell that is blank and unstyled. A row whose own content reaches
 * into a rail column keeps its content and loses the rail there.
 *
 * ## Narrow terminals
 *
 * Indenting unconditionally would eat the content budget and silently truncate
 * the informative end of a row — the failure class the markdown-table column
 * bug came from. treeIndentCols() therefore clamps the indent to whatever still
 * leaves TREE_MIN_CONTENT_COLS of content, and drops to 0 (flush, no branch
 * glyph) when even one level does not fit. Losing the visual nesting on a
 * 30-column terminal is acceptable; losing characters is not.
 */

import { LAYOUT } from './layout.ts';
import type { Line } from '../types/grid.ts';
import { createStyledCell } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

/** Columns added per nesting level. Fixed — never content-dependent. */
const TREE_STEP_COLS = 2;

/**
 * Content columns a branch row is guaranteed to keep. Below this the indent is
 * reduced (and finally dropped) rather than squeezing the row's text.
 */
const TREE_MIN_CONTENT_COLS = 16;

/** Vertical rail drawn in an ancestor's gutter and down an open row's column. */
const TREE_RAIL = '│';

/** The connector a row draws when a sibling follows it below. */
const TREE_CONNECTOR_CONTINUES = '├';

/**
 * Effective indent, in columns, for a branch at `depth` rendered at `width`.
 *
 * Returns 0 for depth <= 0 (a flush, non-branch row) and for widths too narrow
 * to carry even one level while keeping TREE_MIN_CONTENT_COLS of content. The
 * result is always a whole multiple of TREE_STEP_COLS, so branch glyphs across
 * different depths stay on the same column grid.
 */
export function treeIndentCols(depth: number, width: number): number {
  if (depth <= 0) return 0;
  const budget = width - LAYOUT.LEFT_MARGIN - LAYOUT.RIGHT_MARGIN - TREE_MIN_CONTENT_COLS;
  if (budget < TREE_STEP_COLS) return 0;
  const affordableLevels = Math.floor(budget / TREE_STEP_COLS);
  return Math.min(depth, affordableLevels) * TREE_STEP_COLS;
}

/**
 * Column the row's leading glyph occupies for a given effective indent: the
 * `●` of a depth-0 row, the `├`/`└` of a branch row, and the `│` an ancestor
 * carries down through its descendants' rows.
 */
export function treeBranchCol(indentCols: number): number {
  return LAYOUT.LEFT_MARGIN - 1 + indentCols;
}

/**
 * Column at which a row's segment run begins. Segment runs carry one leading
 * blank by convention (` assistant `, ` ▸ 31 lines `, the fragment's ` ▸ `
 * prefix), so this is the gap column and treeTextCol is where glyphs land.
 */
export function treeContentCol(indentCols: number): number {
  return treeBranchCol(indentCols) + 2;
}

/**
 * Column of a row's first PRINTABLE character. Every row type must land its
 * text here — that is the invariant which makes each level step by exactly
 * TREE_STEP_COLS regardless of whether the row came from an event line, a
 * tool-call row or a collapsed fragment.
 */
export function treeTextCol(indentCols: number): number {
  return treeContentCol(indentCols) + 1;
}

/**
 * Write a branch row's status marker into the shared bullet column.
 *
 * Success and failure differ by GLYPH, not only by colour, so the distinction
 * survives a monochrome terminal and colour-blind viewers. A double-width glyph
 * claims its trailing cell too, so the column math stays honest for emoji-class
 * markers instead of leaving a stale half-character behind.
 */
export function writeTreeStatusMarker(
  line: Line,
  glyph: string | null,
  fg: string,
  width: number,
): void {
  if (!glyph) return;
  // THE column: treeBranchCol(0) is where a depth-0 row draws its `●`, so a
  // branch row's marker lands in the bullet column of the turn it belongs to.
  // Derived, never restated, so the two cannot drift apart.
  const col = treeBranchCol(0);
  if (col < 0 || col >= width) return;
  const glyphWidth = getDisplayWidth(glyph);
  if (glyphWidth <= 0) return;
  line[col] = createStyledCell(glyph, { fg, bold: true });
  if (glyphWidth > 1 && col + 1 < width) {
    line[col + 1] = createStyledCell('', { fg, bold: true });
  }
}

/**
 * Columns at which ancestor `│` gutters are drawn for a row at `depth`, given
 * the set of ancestor depths whose subtrees are still open.
 *
 * Clamping can push two levels onto the same column at narrow widths; a gutter
 * is emitted only when it lands strictly left of this row's own connector, so
 * a clamped tree degrades by losing gutters rather than by overwriting the
 * connector.
 */
function treeGutterCols(
  openAncestorDepths: readonly number[],
  depth: number,
  width: number,
): number[] {
  const ownCol = treeBranchCol(treeIndentCols(depth, width));
  const cols: number[] = [];
  for (const ancestorDepth of openAncestorDepths) {
    const col = treeBranchCol(treeIndentCols(ancestorDepth, width));
    if (col < ownCol) cols.push(col);
  }
  return cols;
}

/** True when a rail may claim this cell without destroying rendered content. */
function railCellIsFree(line: Line, col: number): boolean {
  const cell = line[col];
  if (!cell) return false;
  return cell.char === ' ' && !cell.bg;
}

function writeRail(line: Line, col: number, glyph: string, fg: string, width: number, force: boolean): void {
  if (col < 0 || col >= width) return;
  if (!force && !railCellIsFree(line, col)) return;
  line[col] = createStyledCell(glyph, { fg, dim: true });
}

/**
 * Draw a row's connector and every rail that must pass through it, across ALL
 * the lines the row emitted.
 *
 * Line 0 gets the connector in the row's own column (deliberately replacing
 * whatever marker the row drew there — the connector IS that row's marker).
 * Subsequent lines get `│` in that column while the row still has a sibling
 * below it, so the rail runs unbroken from one `├` to the next. Every line
 * additionally gets `│` in each open ancestor's gutter.
 *
 * Connectors and gutters are recomputed from live structure on every rebuild
 * (see conversation-turn-structure.ts), never cached, so a row that stops being
 * last flips `└`→`├` here with nothing stale to invalidate.
 */
export function drawTreeRails(
  lines: readonly Line[],
  depth: number,
  connector: string | undefined,
  openAncestorDepths: readonly number[],
  width: number,
  fg: string,
): void {
  if (depth <= 0 || !connector || lines.length === 0) return;
  const indent = treeIndentCols(depth, width);
  if (indent <= 0) return;
  const ownCol = treeBranchCol(indent);
  const gutterCols = treeGutterCols(openAncestorDepths, depth, width);
  const continuesBelow = connector === TREE_CONNECTOR_CONTINUES;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const gutterCol of gutterCols) {
      writeRail(line, gutterCol, TREE_RAIL, fg, width, false);
    }
    if (i === 0) writeRail(line, ownCol, connector, fg, width, true);
    else if (continuesBelow) writeRail(line, ownCol, TREE_RAIL, fg, width, false);
  }
}
