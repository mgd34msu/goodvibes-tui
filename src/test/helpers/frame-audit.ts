/**
 * frame-audit.ts, the design's layout audit applied to a finished frame.
 *
 * The concept page's audit script checks every drawn screen for:
 *
 *   - OVERFLOW  a row wider than the screen, or a wide glyph cut by its edge
 *   - PADDING   text on a filled block closer than 2 columns to the block's
 *               left or right edge
 *   - VPAD-TOP / VPAD-BOT  a filled block of 3+ rows with text on its first
 *               or last row
 *   - BAR       a ┃ beside a block that does not run the block's full height
 *   - GAP       the bottom of a full screen stacked without its gaps: output
 *               text, the throbber, the input area and the status line must
 *               never touch. The input area (the barred fill block right
 *               above the status line) keeps at least half a row free above
 *               and below it: the row next to its fill holds nothing drawn
 *               but its own cap (a ▄ or ▀ cap row, or an empty row); a
 *               table's └──┘ border counts as output here. The throbber (a spinner glyph in
 *               column 3, text from column 5) sits over a fully empty row,
 *               since a half row cannot be drawn between two rows of text.
 *   - HEADER    output touching the header: on a screen that starts with the
 *               header row (GoodVibes at column 1), the row after the header
 *               block (the header, plus the session chips row when it shows)
 *               holds nothing drawn but a cap; the main screen keeps one
 *               empty row there and a view's body starts with one.
 *
 * (Its fifth check, overlapping text between drawing calls, needs the draw
 * history and does not apply to a finished frame.)
 *
 * The audit script knew where every fill was drawn. A frame only has cells,
 * so blocks are recovered from them: a block is a stack of rows where one
 * FILL color (the theme's surface, element, code and other background tokens)
 * spans the same columns. Cells of any other color inside such a span (a
 * keycap chip, the selected row's gradient, a tinted diff row, an element
 * panel inside a modal) are islands of the row, not breaks in it, the same
 * way the audit script treated drawings on top of a fill.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { PaletteTokens } from '../../renderer/theme.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';
import { SPINNER_FRAMES } from '../../renderer/ui-primitives.ts';

export interface FrameIssue {
  readonly kind: 'OVERFLOW' | 'PADDING' | 'VPAD-TOP' | 'VPAD-BOT' | 'BAR' | 'GAP' | 'HEADER';
  readonly row: number;
  readonly detail: string;
}

/** The token names whose colors are fills (surfaces), rather than chips, tints or gradients. */
export const FILL_TOKENS = [
  'backgroundPanel',
  'backgroundElement',
  'backgroundMenu',
  'backgroundBase',
  'backgroundCode',
  'backgroundTitle',
  'backgroundSection',
  'backgroundSummary',
  'backgroundInput',
  'backgroundFooter',
] as const satisfies readonly (keyof PaletteTokens)[];

/** Characters that are drawing, not text (bars, caps, box pieces). */
function isText(ch: string): boolean {
  if (ch === '' || ch === ' ') return false;
  const code = ch.codePointAt(0)!;
  if (code >= 0x2500 && code <= 0x259f) return false; // box drawing + block elements (┃ ▄ ▀ █ …)
  return true;
}

interface Run { readonly x: number; readonly w: number }
interface Block { x: number; w: number; y: number; h: number; readonly bg: string }

/** Spans of `bg` on one row, allowing islands of other non-empty colors inside. */
function runsOf(row: Line, bg: string): Run[] {
  const runs: Run[] = [];
  let x = 0;
  while (x < row.length) {
    if (row[x]!.bg !== bg) { x++; continue; }
    const start = x;
    let last = x;
    let q = x + 1;
    while (q < row.length) {
      const cell = row[q]!;
      if (cell.bg === bg) { last = q; q++; continue; }
      // An island continues the run only when it is a colored fill of its own
      // and the run's color resumes after it.
      if (cell.bg === '' && cell.char !== '') break;
      let r = q;
      while (r < row.length && row[r]!.bg !== bg && !(row[r]!.bg === '' && row[r]!.char !== '')) r++;
      if (r < row.length && row[r]!.bg === bg) { q = r; continue; }
      break;
    }
    runs.push({ x: start, w: last - start + 1 });
    x = last + 1;
  }
  return runs;
}

function blocksOf(lines: readonly Line[], bg: string): Block[] {
  const done: Block[] = [];
  let open: Block[] = [];
  lines.forEach((row, y) => {
    const next: Block[] = [];
    for (const run of runsOf(row, bg)) {
      const cont = open.find((b) => b.x === run.x && b.w === run.w);
      if (cont) { cont.h++; next.push(cont); } else next.push({ x: run.x, w: run.w, y, h: 1, bg });
    }
    for (const b of open) if (!next.includes(b)) done.push(b);
    open = next;
  });
  return [...done, ...open];
}

/**
 * A row fully covered by an overlay color (a selection gradient or a tinted
 * diff row drawn over the fill edge to edge) does not end the fill: blocks of
 * the same span on both sides of such rows are one block.
 */
function mergeAcrossOverlays(lines: readonly Line[], blocks: Block[], fills: ReadonlySet<string>): Block[] {
  const sorted = [...blocks].sort((a, b) => a.y - b.y);
  const out: Block[] = [];
  for (const block of sorted) {
    const prev = [...out].reverse().find((b) => b.x === block.x && b.w === block.w && b.bg === block.bg && b.y + b.h <= block.y);
    if (prev) {
      let covered = true;
      for (let y = prev.y + prev.h; y < block.y && covered; y++) {
        const cells = (lines[y] ?? []).slice(block.x, block.x + block.w);
        covered = cells.length === block.w && cells.every((c) => c.bg !== '' && !fills.has(c.bg));
      }
      if (covered) {
        prev.h = block.y + block.h - prev.y;
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

function rowText(row: Line, x: number, w: number): string {
  return row.slice(x, x + w).map((c) => c.char || ' ').join('').trim().slice(0, 60);
}

/** Audit one frame (full-width lines) against the fill colors of the theme it was drawn with. */
export function auditFrame(lines: readonly Line[], width: number, tokens: Readonly<PaletteTokens>): FrameIssue[] {
  const issues: FrameIssue[] = [];
  lines.forEach((row, y) => {
    if (row.length > width) issues.push({ kind: 'OVERFLOW', row: y, detail: `row is ${row.length} cells on a ${width}-cell screen` });
    const lastCell = row[width - 1];
    if (lastCell && lastCell.char && getDisplayWidth(lastCell.char) > 1) issues.push({ kind: 'OVERFLOW', row: y, detail: `wide glyph ${lastCell.char} cut by the right edge` });
  });

  const fills = new Set(FILL_TOKENS.map((key) => tokens[key]).filter((c) => c !== ''));
  for (const bg of fills) {
    for (const block of mergeAcrossOverlays(lines, blocksOf(lines, bg), fills)) {
      if (block.w < 6) continue;
      // Padding: text drawn on the fill keeps 2 columns from both edges.
      for (let y = block.y; y < block.y + block.h; y++) {
        const row = lines[y]!;
        let first = -1;
        let last = -1;
        for (let x = block.x; x < block.x + block.w; x++) {
          const cell = row[x]!;
          if (cell.bg === bg && isText(cell.char)) {
            if (first < 0) first = x;
            last = x;
          }
        }
        if (first < 0) continue;
        const left = first - block.x;
        const right = block.x + block.w - 1 - last;
        if (left < 2 || right < 2) issues.push({ kind: 'PADDING', row: y, detail: `left ${left} right ${right} :: ${rowText(row, first, last - first + 1)}` });
      }
      if (block.h < 3 || block.w < 10) continue;
      const textOnFill = (y: number): boolean => (lines[y] ?? []).slice(block.x, block.x + block.w).some((c) => c.bg === bg && isText(c.char));
      if (textOnFill(block.y)) issues.push({ kind: 'VPAD-TOP', row: block.y, detail: `block x${block.x} w${block.w} h${block.h} :: ${rowText(lines[block.y]!, block.x, block.w)}` });
      if (textOnFill(block.y + block.h - 1)) issues.push({ kind: 'VPAD-BOT', row: block.y + block.h - 1, detail: `block x${block.x} w${block.w} h${block.h} :: ${rowText(lines[block.y + block.h - 1]!, block.x, block.w)}` });
      // Bars: a ┃ against the block's left edge runs its full height.
      if (block.x > 0) {
        const bars = Array.from({ length: block.h }, (_, k) => lines[block.y + k]![block.x - 1]?.char === '┃');
        if (bars.some(Boolean) && !bars.every(Boolean)) issues.push({ kind: 'BAR', row: block.y, detail: `bar on ${bars.filter(Boolean).length}/${block.h} rows at x${block.x - 1}` });
      }
    }
  }
  issues.push(...auditStack(lines, fills));
  issues.push(...auditHeaderGap(lines));
  return issues;
}

const rowString = (row: Line | undefined): string => (row ?? []).map((c) => c.char || ' ').join('');

/** The header row: the brand at column 1. */
function isHeaderRow(row: Line | undefined): boolean {
  return rowString(row).startsWith(' GoodVibes');
}

/** The session chips row under the header: the chips, then its tab / shift+tab keys. */
function isChipsRow(row: Line | undefined): boolean {
  return /\btab {2}next\b/.test(rowString(row));
}

/** The HEADER check (see the file header). */
function auditHeaderGap(lines: readonly Line[]): FrameIssue[] {
  if (lines.length < 3 || !isHeaderRow(lines[0])) return [];
  const below = isChipsRow(lines[1]) ? 2 : 1;
  if (!hasContent(lines[below])) return [];
  return [{ kind: 'HEADER', row: below, detail: `output directly under the header :: ${rowText(lines[below]!, 0, lines[below]!.length)}` }];
}

/** The input area's own half-row glyphs: a row of only these (and blanks) is a gap row. */
const CAP_GLYPHS: ReadonlySet<string> = new Set(['▄', '▀', '╻', '╹']);

/** Anything drawn that is not a cap: text, and box drawing too (a table's └──┘ border is output). */
function hasContent(row: Line | undefined): boolean {
  return (row ?? []).some((c) => c.char !== ' ' && c.char !== '' && !CAP_GLYPHS.has(c.char));
}

/** A row with nothing drawn on it at all: no text, no glyph, no fill. */
function isEmptyRow(row: Line | undefined): boolean {
  return (row ?? []).every((c) => (c.char === ' ' || c.char === '') && c.bg === '');
}

const SPINNER_GLYPHS: ReadonlySet<string> = new Set([...SPINNER_FRAMES].flatMap((f) => [...f]));

/** The throbber row: a spinner glyph in column 3, a blank column 4, text from column 5. */
function isThrobberRow(row: Line | undefined): boolean {
  if (!row || row.length < 6) return false;
  return SPINNER_GLYPHS.has(row[3]!.char) && (row[4]!.char === ' ' || row[4]!.char === '') && isText(row[5]!.char)
    && row.slice(0, 3).every((c) => c.char === ' ' || c.char === '');
}

/**
 * The GAP check (see the file header). Applies to a frame whose last row is
 * a status line with the input area's fill ending one or two rows above it.
 */
function auditStack(lines: readonly Line[], fills: ReadonlySet<string>): FrameIssue[] {
  const issues: FrameIssue[] = [];
  const last = lines.length - 1;
  if (last < 2 || !hasContent(lines[last])) return issues;
  // The input area: the lowest fill block with a ┃ against its left edge on every row.
  let input: Block | null = null;
  for (const bg of fills) {
    for (const block of blocksOf(lines, bg)) {
      if (block.x < 1 || block.w < 10) continue;
      const bottom = block.y + block.h - 1;
      if (bottom >= last || bottom < last - 2) continue;
      const barred = Array.from({ length: block.h }, (_, k) => lines[block.y + k]![block.x - 1]?.char === '┃').every(Boolean);
      if (barred && (!input || bottom > input.y + input.h - 1)) input = block;
    }
  }
  if (!input) return issues;
  const below = input.y + input.h;
  if (hasContent(lines[below])) {
    issues.push({ kind: 'GAP', row: below, detail: `text directly under the input area :: ${rowText(lines[below]!, 0, lines[below]!.length)}` });
  }
  const above = input.y - 1;
  if (above >= 0 && hasContent(lines[above])) {
    issues.push({ kind: 'GAP', row: above, detail: `text directly over the input area :: ${rowText(lines[above]!, 0, lines[above]!.length)}` });
  }
  // The throbber: the first text row above the input area's gap row.
  const throbberRow = above - 1;
  if (throbberRow >= 1 && isThrobberRow(lines[throbberRow]) && !isEmptyRow(lines[throbberRow - 1])) {
    issues.push({ kind: 'GAP', row: throbberRow - 1, detail: `no empty row between the throbber and the text above it :: ${rowText(lines[throbberRow - 1]!, 0, lines[throbberRow - 1]!.length)}` });
  }
  return issues;
}
