/**
 * surface-kit-list.ts, list rows and group headers for the modal surface kit.
 *
 *   ✦ group header         lowercase, accent (violet), bold; a blank row above
 *                          every group except the first
 *   ● Label  description             right metadata
 *     wrapped continuation of a long label or description
 *
 * The selected row is the one loud element: a brand → brandEnd gradient inset 2
 * columns from each side of the fill, with dark bold text
 * (selectedListItemText). Long labels and descriptions wrap onto continuation
 * rows; nothing is clipped. When the list does not fit, group spacing collapses
 * first, then the list scrolls around the selected row and reports how many
 * rows are hidden above and below (drawn as a muted "12 more ↓" count).
 */

import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import { MODAL_MARK_INSET, SurfaceCanvas, scrollCountText, type KitStyle } from './surface-kit.ts';

/** A run of text with one style (used for custom labels such as fuzzy-match highlights). */
export interface KitSpan {
  readonly text: string;
  readonly fg?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
}

/** One list row: a group header when `header` is set, an item otherwise. */
export interface KitRow {
  readonly header?: string;
  readonly headerRight?: string;
  readonly label?: string;
  /** Custom label spans; replaces `label` when set. */
  readonly spans?: readonly KitSpan[];
  /** Muted text after the label (wraps with it). */
  readonly desc?: string;
  /** Muted metadata right-aligned on the row's first line. */
  readonly right?: string;
  readonly rightFg?: string;
  /** A marker 2 columns in from the fill edge (● ✓ ◐ ✕ …). */
  readonly mark?: string;
  readonly markFg?: string;
  readonly selected?: boolean;
  /** The active choice: label in the brand color when not selected. */
  readonly current?: boolean;
  /** A destructive / armed row: label in the error color; a red fill instead of the gradient when selected. */
  readonly danger?: boolean;
  readonly labelFg?: string;
  readonly bold?: boolean;
  /** Rows shown dimmer (unavailable entries). */
  readonly muted?: boolean;
}

export function isHeader(row: KitRow): boolean {
  return row.header !== undefined;
}

// ---------------------------------------------------------------------------
// Wrapping styled spans
// ---------------------------------------------------------------------------

interface Piece { text: string; style: KitStyle }

/** Greedy word wrap over styled spans; each output row is a list of pieces. */
function wrapSpans(spans: readonly Piece[], width: number): Piece[][] {
  const rows: Piece[][] = [[]];
  let used = 0;
  const pushText = (text: string, style: KitStyle): void => {
    const row = rows[rows.length - 1]!;
    const last = row[row.length - 1];
    if (last && last.style === style) last.text += text;
    else row.push({ text, style });
    used += getDisplayWidth(text);
  };
  const newRow = (): void => { rows.push([]); used = 0; };
  for (const span of spans) {
    // Split into words keeping the separating spaces attached to the front.
    const words = span.text.split(/(?= )/);
    for (const raw of words) {
      let word = raw;
      const w = getDisplayWidth(word);
      if (used > 0 && used + w > width) {
        newRow();
        word = word.replace(/^ +/, '');
      } else if (used === 0) {
        word = word.replace(/^ +/, '');
      }
      // A word longer than the row: hard-split it.
      while (getDisplayWidth(word) > width) {
        let cut = '';
        let cw = 0;
        for (const ch of word) {
          const chw = getDisplayWidth(ch);
          if (used + cw + chw > width) break;
          cut += ch;
          cw += chw;
        }
        if (cut.length === 0) { newRow(); continue; }
        pushText(cut, span.style);
        word = word.slice(cut.length);
        newRow();
      }
      if (word.length > 0) pushText(word, span.style);
    }
  }
  return rows.filter((row, k) => row.length > 0 || k === 0);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RowLayout {
  readonly lines: Piece[][];
  readonly right?: string;
}

function rowPieces(row: KitRow): Piece[] {
  const t = activeTokens();
  const sel = row.selected === true;
  const ink = t.selectedListItemText;
  const labelFg = sel ? ink
    : row.danger ? t.error
    : row.current ? t.brand
    : row.muted ? t.textFaint
    : row.labelFg ?? t.text;
  const pieces: Piece[] = [];
  if (row.spans) {
    for (const span of row.spans) {
      pieces.push({ text: span.text, style: { fg: sel ? ink : span.fg ?? labelFg, bold: sel || span.bold === true, italic: span.italic, strikethrough: span.strikethrough } });
    }
  } else {
    pieces.push({ text: row.label ?? '', style: { fg: labelFg, bold: sel || row.bold === true } });
  }
  if (row.desc) pieces.push({ text: `  ${row.desc}`, style: { fg: sel ? ink : t.textMuted } });
  return pieces;
}

function layoutRow(row: KitRow, x0: number, x1: number): RowLayout {
  const width = Math.max(1, x1 - x0 + 1);
  if (isHeader(row)) return { lines: [[{ text: row.header!.toLowerCase(), style: {} }]], right: row.headerRight };
  const rightW = row.right ? getDisplayWidth(row.right) + 2 : 0;
  const textW = Math.max(4, width - rightW);
  const lines = wrapSpans(rowPieces(row), textW);
  return { lines, right: row.right };
}

/** Rows a list row takes at the given text span. */
export function measureRow(row: KitRow, x0: number, x1: number): number {
  return layoutRow(row, x0, x1).lines.length;
}

/**
 * Draw one row (header or item) with its text starting at x0 and right
 * metadata ending at x1. Returns the number of canvas rows used.
 */
export function drawRow(canvas: SurfaceCanvas, y: number, row: KitRow, x0: number, x1: number, maxY = Number.POSITIVE_INFINITY): number {
  const t = activeTokens();
  const layout = layoutRow(row, x0, x1);
  if (isHeader(row)) {
    canvas.put(x0 - MODAL_MARK_INSET, y, '✦', { fg: t.brandEnd });
    canvas.put(x0, y, row.header!.toLowerCase(), { fg: t.accent, bold: true });
    if (row.headerRight) canvas.right(x1, y, row.headerRight, { fg: t.textFaint });
    return 1;
  }
  const sel = row.selected === true;
  const ink = t.selectedListItemText;
  const used = Math.min(layout.lines.length, Math.max(1, maxY - y + 1));
  if (sel) {
    // An armed (danger) row is red, not the gradient: it is about to do something destructive.
    const span = x1 - x0 + 1 + 2 * MODAL_MARK_INSET;
    for (let k = 0; k < used; k++) {
      if (row.danger) canvas.tint(x0 - MODAL_MARK_INSET, y + k, span, t.error);
      else canvas.grad(x0 - MODAL_MARK_INSET, y + k, span, t.brand, t.brandEnd);
    }
  }
  if (row.mark) canvas.put(x0 - MODAL_MARK_INSET, y, row.mark, { fg: sel ? ink : row.markFg ?? t.brand, bold: sel });
  for (let k = 0; k < used; k++) {
    let cx = x0;
    for (const piece of layout.lines[k]!) cx = canvas.put(cx, y + k, piece.text, piece.style);
  }
  if (layout.right) canvas.right(x1, y, layout.right, { fg: sel ? ink : row.rightFg ?? t.textFaint, bold: false });
  return used;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export interface KitListOptions {
  readonly rows: readonly KitRow[];
  /** First and last canvas rows the list may use (inclusive). */
  readonly top: number;
  readonly bottom: number;
  readonly x0: number;
  readonly x1: number;
  /** Row index to start from when scrolling (clamped so the selected row stays visible). */
  readonly scrollStart?: number;
  /**
   * Remember this list's scroll position between renders (keyed by an owner
   * object, usually the modal's state, and a list name), so the window only
   * moves when the selection leaves it instead of re-anchoring every frame.
   */
  readonly scrollKey?: { readonly owner: object; readonly name: string };
}

const scrollMemory = new WeakMap<object, Map<string, number>>();

/** The remembered first row of a list (see KitListOptions.scrollKey). */
export function rememberedStart(key: KitListOptions['scrollKey']): number | undefined {
  return key ? scrollMemory.get(key.owner)?.get(key.name) : undefined;
}

/** Record a list's first row for the next render. */
export function rememberStart(key: KitListOptions['scrollKey'], start: number): void {
  if (!key) return;
  let names = scrollMemory.get(key.owner);
  if (!names) {
    names = new Map();
    scrollMemory.set(key.owner, names);
  }
  names.set(key.name, start);
}

export interface KitListResult {
  /** Item rows (headers excluded) hidden above / below the window. */
  readonly above: number;
  readonly below: number;
  /** Index of the first row drawn. */
  readonly start: number;
  /** Canvas row after the last row drawn. */
  readonly endY: number;
}

/**
 * Draw a list of rows between `top` and `bottom`, keeping the selected row in
 * view. Group spacing (the blank row above each header but the first) is kept
 * while everything fits and collapses before any row is cut.
 */
export function drawList(canvas: SurfaceCanvas, options: KitListOptions): KitListResult {
  const { rows, top, bottom, x0, x1 } = options;
  const capacity = Math.max(1, bottom - top + 1);
  const heights = rows.map((row) => measureRow(row, x0, x1));
  const selected = rows.findIndex((row) => row.selected === true);

  // Prefix sums keep every span query O(1): catalogs run to thousands of rows.
  const heightPre = [0];
  const headerPre = [0];
  for (let i = 0; i < rows.length; i++) {
    heightPre.push(heightPre[i]! + heights[i]!);
    headerPre.push(headerPre[i]! + (isHeader(rows[i]!) ? 1 : 0));
  }
  const spanOf = (from: number, to: number, gaps: boolean): number => {
    if (to < from) return 0;
    const base = heightPre[to + 1]! - heightPre[from]!;
    // A blank row above every header after the first row of the span.
    return gaps ? base + (headerPre[to + 1]! - headerPre[from + 1]!) : base;
  };

  let start = 0;
  let gaps = true;
  if (rows.length > 0 && spanOf(0, rows.length - 1, true) > capacity) {
    gaps = false;
    if (spanOf(0, rows.length - 1, false) > capacity) {
      start = Math.max(0, Math.min(rememberedStart(options.scrollKey) ?? options.scrollStart ?? 0, rows.length - 1));
      if (selected >= 0) {
        if (selected < start) start = selected;
        while (start < selected && spanOf(start, selected, false) > capacity) start++;
        // Show the selected row's group header when there is room for it.
        if (start > 0 && start === selected && isHeader(rows[start - 1]!) && spanOf(start - 1, selected, false) <= capacity) start--;
      }
      // Do not leave empty space at the end when scrolled down.
      while (start > 0 && spanOf(start - 1, rows.length - 1, false) <= capacity) start--;
    }
  }

  rememberStart(options.scrollKey, start);
  let y = top;
  let last = start - 1;
  for (let i = start; i < rows.length; i++) {
    const gap = gaps && i > start && isHeader(rows[i]!) ? 1 : 0;
    if (y + gap > bottom) break;
    // A header with no room for an item under it is left for the next page.
    if (isHeader(rows[i]!) && y + gap + 1 > bottom && i < rows.length - 1) break;
    y += gap;
    const used = drawRow(canvas, y, rows[i]!, x0, x1, bottom);
    y += used;
    last = i;
    if (used < heights[i]!) break;
  }
  const countItems = (from: number, to: number): number => {
    let n = 0;
    for (let i = from; i <= to; i++) if (!isHeader(rows[i]!)) n++;
    return n;
  };
  return {
    above: countItems(0, start - 1),
    below: countItems(last + 1, rows.length - 1),
    start,
    endY: y,
  };
}

/**
 * drawList for a pane that has no hint row of its own: when rows are hidden,
 * the pane's last row carries the muted scroll count ("3 more ↑ · 12 more ↓").
 */
export function drawScrollingList(canvas: SurfaceCanvas, options: KitListOptions): KitListResult {
  const scratch = new SurfaceCanvas(canvas.width, canvas.height);
  const trial = drawList(scratch, options);
  if (trial.above === 0 && trial.below === 0) return drawList(canvas, options);
  const result = drawList(canvas, { ...options, bottom: options.bottom - 1 });
  const text = scrollCountText(result.above, result.below);
  if (text) canvas.right(options.x1, options.bottom, text, { fg: activeTokens().textFaint });
  return result;
}
