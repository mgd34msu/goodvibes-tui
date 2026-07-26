/**
 * conversation-tree.ts — column geometry for the transcript's branch tree.
 *
 * The transcript renders an assistant turn as a small tree: the turn header at
 * depth 0, each tool call it issues as a depth-1 branch, and each call's result
 * as a depth-2 branch under that call. This module owns the *only* arithmetic
 * that decides where those branch glyphs and their content land, so every row
 * type (event lines, tool-call rows, collapsed fragments) agrees on a single
 * column grid instead of each re-deriving it.
 *
 * Geometry, relative to the existing flush layout (LAYOUT.LEFT_MARGIN = 4):
 *
 *   depth 0   `  ● assistant …`         marker col 3, content col 5
 *   depth 1   `✓   ├ config.get …`       connector col 5, content col 7
 *   depth 2   `✓   │ └ ▸ 627 lines …`    connector col 7, content col 9
 *
 * The connector sits where the parent's content began, and content starts two
 * columns after it — the same marker→content relationship a depth-0 row has.
 * Status lives in a fixed gutter at column 0, OUTSIDE the indent, so every ✓
 * and ✗ in the transcript lines up in one column regardless of nesting depth.
 *
 * Every level steps by exactly TREE_STEP_COLS, and indent, gutter and content
 * columns are functions of depth and width ALONE — never of sibling status.
 * That is what makes a `└`→`├` connector flip cost exactly one cell: the
 * column it occupies exists either way, so no text moves.
 *
 * Narrow terminals: indenting unconditionally would eat the content budget and
 * silently truncate the informative end of a row — the failure class the
 * markdown-table column bug came from. treeIndentCols() therefore clamps the
 * indent to whatever still leaves TREE_MIN_CONTENT_COLS of content, and drops
 * to 0 (flush, no branch glyph) when even one level does not fit. Losing the
 * visual nesting on a 30-column terminal is acceptable; losing characters is
 * not.
 */

import { LAYOUT } from './layout.ts';
import type { Line } from '../types/grid.ts';
import { createStyledCell } from '../types/grid.ts';

/** Columns added per nesting level. Fixed — never content-dependent. */
const TREE_STEP_COLS = 2;

/**
 * Width of the reserved status column that every row carries, at every depth.
 *
 * The column exists whether or not the row currently has a marker: a completed
 * row shows ✓, a failed row its failure glyph, an in-flight or plain row a
 * blank of the same width. Because the space is always reserved, a marker
 * appearing or resolving changes only that cell's contents and can never shift
 * the label beside it. Combined with fixed per-depth indentation this gives the
 * whole tree one rule: columns are fixed, only their contents change.
 */
const TREE_STATUS_COLS = 2;

/**
 * Content columns a branch row is guaranteed to keep. Below this the indent is
 * reduced (and finally dropped) rather than squeezing the row's text.
 */
const TREE_MIN_CONTENT_COLS = 16;


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
  // The status gutter is charged first and never given back — see TREE_GUTTER_COL.
  const budget = width - LAYOUT.LEFT_MARGIN - LAYOUT.RIGHT_MARGIN - TREE_STATUS_COLS - TREE_MIN_CONTENT_COLS;
  if (budget < TREE_STEP_COLS) return 0;
  const affordableLevels = Math.floor(budget / TREE_STEP_COLS);
  return Math.min(depth, affordableLevels) * TREE_STEP_COLS;
}

/**
 * Write the status gutter for a row: `glyph` when it has one, an untouched
 * blank of the same width when it does not. Success and failure differ by
 * GLYPH, not only by colour, so the distinction survives a monochrome terminal
 * and colour-blind viewers.
 */
export function writeTreeStatusGutter(
  line: Line,
  glyph: string | null,
  fg: string,
  width: number,
): void {
  if (!glyph || TREE_GUTTER_COL >= width) return;
  line[TREE_GUTTER_COL] = createStyledCell(glyph, { fg, bold: true });
}

/**
 * Column the connector (`├`/`└`) occupies for a given effective indent, and
 * the column an ancestor's `│` gutter occupies at that same indent.
 */
export function treeBranchCol(indentCols: number): number {
  return LAYOUT.LEFT_MARGIN - 1 + indentCols;
}

/**
 * The status gutter: a fixed column at the far LEFT of every row, before any
 * indentation, carrying ✓ / ✕ / blank.
 *
 * Deliberately outside the indent so it does not scale with depth. With the
 * marker placed after the connector instead, status would sit at a different
 * horizontal position on every row depending on nesting, so scanning for what
 * completed means tracking a ragged edge — and that degrades precisely as
 * trees get deeper. Here every marker in the transcript lines up in one
 * column no matter how deep its row sits, for the cost of one fixed column.
 *
 * It is never clamped: narrow terminals clamp the INDENT (see treeIndentCols)
 * and leave the gutter intact, because losing nesting depth is recoverable by
 * widening the terminal while losing which rows succeeded is not.
 */
const TREE_GUTTER_COL = 0;

/** Column where a branch row's text starts, immediately after its connector. */
export function treeContentCol(indentCols: number): number {
  return treeBranchCol(indentCols) + 2;
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

/**
 * Draw a branch row's connector and the `│` gutters of its still-open
 * ancestors onto an already-rendered line, in place.
 *
 * Connectors are recomputed from live structure on every rebuild (see
 * conversation-turn-structure.ts), never cached, so a row that stops being
 * last flips `└`→`├` here with nothing stale to invalidate. Only this cell
 * changes: indent, status gutter and content column are functions of depth and
 * width alone, so a sibling arriving repaints one connector cell and moves no
 * text.
 */
export function drawBranchConnector(
  line: Line,
  depth: number,
  connector: string | undefined,
  openAncestorDepths: readonly number[],
  width: number,
  fg: string,
): void {
  if (depth <= 0 || !connector) return;
  const indent = treeIndentCols(depth, width);
  if (indent <= 0) return;
  for (const gutterCol of treeGutterCols(openAncestorDepths, depth, width)) {
    if (gutterCol >= 0 && gutterCol < width) {
      line[gutterCol] = createStyledCell('\u2502', { fg, dim: true });
    }
  }
  const col = treeBranchCol(indent);
  if (col >= 0 && col < width) {
    line[col] = createStyledCell(connector, { fg, dim: true });
  }
}
