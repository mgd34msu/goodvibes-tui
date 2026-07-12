/**
 * Liveness contract harness (c) — reusable, surface-agnostic assertions.
 *
 * A live-updating modal must mutate VALUES in place: rows never reflow under the
 * cursor mid-edit, and any structural layout change waits for an interaction
 * boundary. These helpers make that contract testable by comparing two rendered
 * frames — A (initial, cursor at row R) and B (after a values-only update).
 *
 * The integrator can point the same helpers at the provider/MCP modals
 * by rendering the two frames and calling assertFrameLiveness(A, B). It is seeded
 * against the settings modal in liveness-contract.test.ts.
 *
 * Contract enforced by assertFrameLiveness(A, B):
 *   1. identical line count and per-line width (no rows/columns added or removed);
 *   2. an identical STRUCTURAL-glyph skeleton — every box border, separator, tree
 *      connector, and gutter/selection marker sits at the exact same (row,col) in
 *      both frames (nothing reflowed);
 *   3. the selection marker resolves to the same row (the cursor did not jump);
 *   4. (optional) every differing cell falls inside a caller-declared value
 *      region — proving ONLY values changed.
 */

import { expect } from 'bun:test';
import type { Line } from '../../types/grid.ts';

/** Box-drawing chrome + gutter/selection markers whose positions define the frame skeleton. */
export const DEFAULT_STRUCTURAL_GLYPHS: ReadonlySet<string> = new Set([
  ...'│─┌┐└┘├┤┬┴┼╭╮╯╰║═╔╗╚╝╠╣╦╩╬', // box drawing
  ...'▸▶►❯➤◆◇•',                     // selection + gutter markers
]);

/** Glyphs that mark the currently-selected row. */
export const DEFAULT_SELECTION_GLYPHS: ReadonlySet<string> = new Set(['▸', '▶', '►', '❯', '➤']);

export interface LivenessOptions {
  readonly structuralGlyphs?: ReadonlySet<string>;
  readonly selectionGlyphs?: ReadonlySet<string>;
  /**
   * (row,col) => true if the cell is a declared VALUE cell allowed to differ.
   * When provided, any differing cell OUTSIDE it fails the contract.
   */
  readonly isValueCell?: (row: number, col: number) => boolean;
}

export interface CellDiff {
  readonly row: number;
  readonly col: number;
  readonly from: string;
  readonly to: string;
}

/** Every (row,col) whose rendered char differs between the two frames. */
export function differingCells(a: Line[], b: Line[]): CellDiff[] {
  const diffs: CellDiff[] = [];
  const rows = Math.min(a.length, b.length);
  for (let r = 0; r < rows; r++) {
    const ra = a[r]!;
    const rb = b[r]!;
    const cols = Math.min(ra.length, rb.length);
    for (let c = 0; c < cols; c++) {
      const from = ra[c]!.char;
      const to = rb[c]!.char;
      if (from !== to) diffs.push({ row: r, col: c, from, to });
    }
  }
  return diffs;
}

/** Row index of the first line containing a selection glyph, or -1 if none. */
export function selectionRow(frame: Line[], selectionGlyphs: ReadonlySet<string> = DEFAULT_SELECTION_GLYPHS): number {
  for (let r = 0; r < frame.length; r++) {
    if (frame[r]!.some((cell) => selectionGlyphs.has(cell.char))) return r;
  }
  return -1;
}

/** Serialize a frame's structural skeleton: one "row:col:char" token per structural cell. */
function skeleton(frame: Line[], structural: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let r = 0; r < frame.length; r++) {
    const row = frame[r]!;
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!.char;
      if (structural.has(ch)) out.push(`${r}:${c}:${ch}`);
    }
  }
  return out;
}

/**
 * Assert frame B is a liveness-preserving VALUE update of frame A. Throws (via
 * bun:test expect) on the first violated invariant.
 */
export function assertFrameLiveness(a: Line[], b: Line[], opts: LivenessOptions = {}): void {
  const structural = opts.structuralGlyphs ?? DEFAULT_STRUCTURAL_GLYPHS;
  const selection = opts.selectionGlyphs ?? DEFAULT_SELECTION_GLYPHS;

  // (1) line count + per-line width unchanged (no rows/columns added or removed).
  expect(b.length).toBe(a.length);
  for (let r = 0; r < a.length; r++) {
    expect(b[r]!.length).toBe(a[r]!.length);
  }

  // (2) structural skeleton identical — nothing reflowed.
  expect(skeleton(b, structural)).toEqual(skeleton(a, structural));

  // (3) the selection marker is on the same row (the cursor did not jump).
  expect(selectionRow(b, selection)).toBe(selectionRow(a, selection));

  // (4) only declared value cells differ (when a predicate is supplied).
  if (opts.isValueCell) {
    const stray = differingCells(a, b).filter((d) => !opts.isValueCell!(d.row, d.col));
    expect(stray).toEqual([]);
  }
}
