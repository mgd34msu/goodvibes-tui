/**
 * surface-kit.ts, the shared modal surface kit.
 *
 * Every modal and overlay is drawn with these helpers, which is what keeps them
 * consistent. The numbers are the Measurements table of the design:
 *
 *   - Modal: 86% of the terminal width (at most 124 columns), top edge at 8% of
 *     the height. Below 90 columns it takes the full width minus 1 per side.
 *   - A gradient half-block cap row (▄, brand → brandEnd) sits above the fill
 *     and a surface-colored ▀ cap row below it. No box-drawing frame.
 *   - 4 columns of inner padding on both sides; row markers 2 columns in from
 *     the edge; the selected row's gradient is inset 2 columns from each side.
 *   - Title on the first content row (✦ + bold title + `esc` keycap right),
 *     hints on the second-to-last row, the last row empty.
 *
 * Coordinates: a modal is drawn into a SurfaceCanvas that covers the modal's
 * columns and its rows from the top cap to the bottom cap. The canvas is then
 * handed to the compositor as a SurfaceLayer (screen x/y of its top-left).
 * Cells whose bg is '' keep whatever is underneath (the caps' other half).
 *
 * Colors come only from the active theme's tokens (activeTokens()).
 */

import { createEmptyCell, type Cell, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { mixHex } from '@pellux/goodvibes-sdk/platform/presentation';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** A rectangle of cells stamped over the composed screen. */
export interface SurfaceLayer {
  /** Screen column of the layer's first cell. */
  readonly x: number;
  /** Screen row of the layer's first line. */
  readonly y: number;
  /** The cells. A cell with bg '' keeps the bg underneath it. */
  readonly lines: Line[];
  /** Dim the whole screen before this layer is stamped (modals do; popups and toasts do not). */
  readonly dim: boolean;
}

/**
 * A cell the stamp skips entirely (the screen underneath shows through):
 * empty char, fg and bg. Wide-character continuation cells keep their fg, so
 * they are never mistaken for one.
 */
export function transparentCell(): Cell {
  return { ...createEmptyCell(), char: '', fg: '', bg: '' };
}

export function isTransparentCell(cell: Cell): boolean {
  return cell.char === '' && cell.fg === '' && cell.bg === '';
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

export interface KitStyle {
  fg?: string;
  /** undefined keeps the cell's current bg (text drawn on a fill stays on it). */
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dim?: boolean;
}

/** A width x height grid of cells with the concept's small painter API. */
export class SurfaceCanvas {
  readonly lines: Line[];

  constructor(readonly width: number, readonly height: number) {
    this.lines = Array.from({ length: Math.max(0, height) }, () =>
      Array.from({ length: Math.max(0, width) }, () => createEmptyCell()));
  }

  cell(x: number, y: number): Cell | undefined {
    return this.lines[y]?.[x];
  }

  /**
   * Write `text` from column x on row y; returns the column after the last
   * character written. Wide characters take two cells (the second is an empty
   * continuation cell). Characters past the canvas edge are dropped.
   */
  put(x: number, y: number, text: string, style: KitStyle = {}): number {
    const row = this.lines[y];
    let cx = x;
    for (const ch of text) {
      const w = getDisplayWidth(ch);
      if (w <= 0) continue;
      if (row && cx >= 0 && cx + w - 1 < this.width) {
        const prev = row[cx]!;
        row[cx] = {
          char: ch,
          fg: style.fg ?? activeTokens().text,
          bg: style.bg ?? prev.bg,
          bold: style.bold ?? false,
          dim: style.dim ?? false,
          underline: style.underline ?? false,
          italic: style.italic ?? false,
          strikethrough: style.strikethrough ?? false,
        };
        if (w === 2) row[cx + 1] = { ...row[cx]!, char: '' };
      }
      cx += w;
    }
    return cx;
  }

  /** Write `text` so its last cell sits on column xr; returns the start column. */
  right(xr: number, y: number, text: string, style: KitStyle = {}): number {
    const start = xr - getDisplayWidth(text) + 1;
    this.put(start, y, text, style);
    return start;
  }

  /** Fill a rectangle with `bg`, clearing its characters. */
  fill(x: number, y: number, w: number, h: number, bg: string): void {
    for (let r = y; r < y + h; r++) {
      const row = this.lines[r];
      if (!row) continue;
      for (let q = x; q < x + w; q++) {
        if (q < 0 || q >= this.width) continue;
        row[q] = { ...createEmptyCell(), bg };
      }
    }
  }

  /** Change the bg of `w` cells on row y, keeping their characters. */
  tint(x: number, y: number, w: number, bg: string): void {
    const row = this.lines[y];
    if (!row) return;
    for (let q = x; q < x + w; q++) {
      const c = row[q];
      if (c) row[q] = { ...c, bg };
    }
  }

  /** A horizontal bg gradient from `from` to `to` across `w` cells. */
  grad(x: number, y: number, w: number, from: string, to: string): void {
    const row = this.lines[y];
    if (!row) return;
    for (let q = 0; q < w; q++) {
      const c = row[x + q];
      if (c) row[x + q] = { ...c, bg: gradientAt(from, to, q, w) };
    }
  }

  /** Text whose fg runs along a gradient; returns the column after it. */
  gradFg(x: number, y: number, text: string, from: string, to: string, style: KitStyle = {}): number {
    const chars = [...text];
    let cx = x;
    chars.forEach((ch, k) => {
      cx = this.put(cx, y, ch, { ...style, fg: gradientAt(from, to, k, chars.length) });
    });
    return cx;
  }
}

/** Color at step k of n along from → to. */
function gradientAt(from: string, to: string, k: number, n: number): string {
  return mixHex(from, to, n > 1 ? k / (n - 1) : 0);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Width below which modals take the full width minus 1 per side. */
const NARROW_MODAL_BREAKPOINT = 90;
/** Upper bound on a modal's width. */
const MAX_MODAL_WIDTH = 124;
/** Columns between the fill edge and text. */
export const MODAL_PAD_X = 4;
/** Columns between the fill edge and a row marker / the selection gradient. */
export const MODAL_MARK_INSET = 2;

export interface ModalGeometry {
  /** Screen column of the fill's left edge. */
  readonly x: number;
  /** Screen row of the fill's first row (the cap sits on y - 1). */
  readonly y: number;
  readonly w: number;
  /** Rows of fill (caps excluded). */
  readonly h: number;
}

export interface ModalGeometryOptions {
  /** Preferred width; defaults to the 86% rule. Always clamped to the screen. */
  readonly width?: number;
  /** Preferred fill height; defaults to the tallest the screen allows. */
  readonly height?: number;
  /** Center vertically (small dialogs) instead of the 8% top edge. */
  readonly center?: boolean;
}

/** The standard modal width for a screen width. */
export function standardModalWidth(screenW: number): number {
  if (screenW < NARROW_MODAL_BREAKPOINT) return Math.max(10, screenW - 2);
  return Math.min(MAX_MODAL_WIDTH, Math.round(screenW * 0.86), screenW - 2);
}

/** The top edge row for a screen height (8%, at least 1 so the cap fits). */
function standardModalTop(screenH: number): number {
  return Math.max(1, Math.round(screenH * 0.08));
}

/** The tallest fill that keeps a dimmed margin below the bottom cap as wide as the one above. */
export function maxModalHeight(screenH: number): number {
  const y = standardModalTop(screenH);
  return Math.max(5, screenH - 2 * y);
}

export function modalGeometry(screenW: number, screenH: number, options: ModalGeometryOptions = {}): ModalGeometry {
  const maxW = screenW < NARROW_MODAL_BREAKPOINT ? Math.max(10, screenW - 2) : Math.max(10, screenW - 2);
  const w = Math.max(10, Math.min(options.width ?? standardModalWidth(screenW), maxW));
  const x = Math.max(0, Math.floor((screenW - w) / 2));
  const top = standardModalTop(screenH);
  const maxH = maxModalHeight(screenH);
  const h = Math.max(5, Math.min(options.height ?? maxH, maxH));
  const y = options.center
    ? Math.max(top, Math.min(screenH - h - 1, Math.round((screenH - h) / 2)))
    : top;
  return { x, y, w, h };
}

// ---------------------------------------------------------------------------
// Keycaps and hints
// ---------------------------------------------------------------------------

/** One hint: the key (drawn as a keycap) and its action (muted). */
export type KitHint = readonly [key: string, action: string];

/** Width of ` key `. */
function keycapWidth(key: string): number {
  return getDisplayWidth(key) + 2;
}

/** A key drawn as a small filled chip: bold text on the border fill. Returns the column after it. */
function keycap(canvas: SurfaceCanvas, x: number, y: number, key: string): number {
  const t = activeTokens();
  return canvas.put(x, y, ` ${key} `, { fg: t.text, bg: t.border, bold: true });
}

/** Gap between one hint's action and the next hint's key. */
const HINT_GAP = 3;

/**
 * A hint wider than a whole row keeps its keycap on the first row and wraps
 * its action onto rows of its own (an empty key draws no keycap).
 */
function splitWideHint(hint: KitHint, width: number): KitHint[] {
  const first = Math.max(1, width - keycapWidth(hint[0]) - 1);
  const words = hint[1].split(' ');
  const parts: string[] = [];
  let line = '';
  let room = first;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (getDisplayWidth(candidate) > room && line) {
      parts.push(line);
      line = word;
      room = width;
    } else {
      line = candidate;
    }
  }
  if (line) parts.push(line);
  return parts.map((part, i) => [i === 0 ? hint[0] : '', clipText(part, i === 0 ? first : width)] as const);
}

/** Lay hints into rows no wider than `width`; each entry is the hints of one row. */
export function layoutHintRows(hints: readonly KitHint[], width: number): KitHint[][] {
  const rows: KitHint[][] = [];
  let current: KitHint[] = [];
  let used = 0;
  const expanded = hints.flatMap((hint) => (keycapWidth(hint[0]) + 1 + getDisplayWidth(hint[1]) > width ? splitWideHint(hint, width) : [hint]));
  for (const hint of expanded) {
    if (hint[0] === '') {
      // A wrapped action continues on a row of its own.
      if (current.length > 0) rows.push(current);
      rows.push([hint]);
      current = [];
      used = 0;
      continue;
    }
    const w = keycapWidth(hint[0]) + 1 + getDisplayWidth(hint[1]);
    const need = current.length === 0 ? w : used + HINT_GAP + w;
    if (current.length > 0 && need > width) {
      rows.push(current);
      current = [hint];
      used = w;
    } else {
      current.push(hint);
      used = need;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Draw one row of hints from column x; returns the column after the last action. */
function drawHintRow(canvas: SurfaceCanvas, x: number, y: number, hints: readonly KitHint[]): number {
  const t = activeTokens();
  let cx = x;
  hints.forEach(([key, action], k) => {
    if (k > 0) cx += HINT_GAP;
    if (key === '') {
      cx = canvas.put(cx, y, action, { fg: t.textMuted });
      return;
    }
    cx = keycap(canvas, cx, y, key);
    cx = canvas.put(cx + 1, y, action, { fg: t.textMuted });
  });
  return cx;
}

/** A muted scroll count, e.g. "12 more ↓" or "3 more ↑ · 12 more ↓". '' when nothing is hidden. */
export function scrollCountText(above: number, below: number): string {
  const parts: string[] = [];
  if (above > 0) parts.push(`${above} more ↑`);
  if (below > 0) parts.push(`${below} more ↓`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Modal frame
// ---------------------------------------------------------------------------

export interface ModalOptions extends ModalGeometryOptions {
  readonly title: string;
  /** Breadcrumb parts drawn after the title as › part › part. */
  readonly crumbs?: readonly string[];
  /** A muted note after the title (and crumbs). */
  readonly sub?: string;
  /** Keycap hints for the second-to-last row. Wrap to more rows when they do not fit. */
  readonly hints?: readonly KitHint[];
  /** Top cap color: the brand gradient (default) or a solid warning strip ("this needs you"). */
  readonly cap?: 'brand' | 'warning' | 'danger';
  /** Draw the `esc` keycap on the title row (default true). */
  readonly escKey?: boolean;
  /** Dim the screen behind the modal (default true). */
  readonly dim?: boolean;
  /** Title glyph; defaults to ✦ in the brand gradient. */
  readonly titleGlyph?: { readonly char: string; readonly fg: string };
}

/**
 * A modal being drawn. All coordinates are canvas coordinates: canvas row 0 is
 * the top cap, rows 1..h are the fill, row h+1 is the bottom cap; canvas column
 * 0 is the fill's left edge.
 */
export interface ModalFrame {
  readonly canvas: SurfaceCanvas;
  readonly geometry: ModalGeometry;
  /** First text column (4 in from the left edge). */
  readonly l: number;
  /** Last text column (4 in from the right edge). */
  readonly r: number;
  /** The title row. */
  readonly t: number;
  /** First body row (one blank row under the title). */
  readonly top: number;
  /** Last body row (a blank row separates it from the hints). */
  readonly bottom: number;
  /** First hint row. */
  readonly hintTop: number;
  readonly hintRows: KitHint[][];
  readonly dim: boolean;
  /** Right-aligned text on the last hint row (typically a scroll count). */
  hintRight: string;
}

/** The text width inside a modal of width w. */
export function modalInnerWidth(w: number): number {
  return Math.max(1, w - 2 * MODAL_PAD_X);
}

/** Room kept on the hint row for a right-aligned scroll count ("12 more ↓"). */
const HINT_RIGHT_RESERVE = 12;

/**
 * The width hints are laid out in for a modal with `inner` text columns. Wide
 * modals keep room for the scroll count beside the hints; narrow ones give
 * the hints the whole row (the count moves to the row above them).
 */
export function hintLayoutWidth(inner: number): number {
  return inner >= 60 ? inner - HINT_RIGHT_RESERVE : Math.max(1, inner);
}

/** Open a modal: fill, caps, title row and the space for hint rows. Draw the body, then call finishModal. */
export function beginModal(screenW: number, screenH: number, options: ModalOptions): ModalFrame {
  const t = activeTokens();
  const geometry = modalGeometry(screenW, screenH, options);
  const { w, h } = geometry;
  const canvas = new SurfaceCanvas(w, h + 2);
  canvas.fill(0, 1, w, h, t.backgroundPanel);

  // Soft caps: ▄ above in the brand gradient (or a warning strip), ▀ below in the surface color.
  const capFrom = options.cap === 'warning' ? t.warning : options.cap === 'danger' ? t.error : t.brand;
  const capTo = options.cap === 'warning' ? t.warning : options.cap === 'danger' ? t.error : t.brandEnd;
  for (let q = 0; q < w; q++) {
    canvas.lines[0]![q] = { ...createEmptyCell(), char: '▄', fg: gradientAt(capFrom, capTo, q, w) };
    canvas.lines[h + 1]![q] = { ...createEmptyCell(), char: '▀', fg: t.backgroundPanel };
  }

  const l = MODAL_PAD_X;
  const r = w - MODAL_PAD_X - 1;
  const titleRow = 2;
  const hints = options.hints ?? [];
  const hintRows = hints.length > 0 ? layoutHintRows(hints, hintLayoutWidth(r - l + 1)) : [];
  // The last fill row (canvas row h) stays empty; hints end on the row above it.
  const lastHintRow = h - 1;
  const hintTop = hintRows.length > 0 ? lastHintRow - hintRows.length + 1 : lastHintRow;
  const bottom = hintRows.length > 0 ? hintTop - 2 : lastHintRow;

  // Title row: ✦ + bold title + crumbs + sub, esc keycap on the right.
  const escW = options.escKey === false ? 0 : keycapWidth('esc') + 2;
  let tx = l;
  if (options.titleGlyph) tx = canvas.put(tx, titleRow, options.titleGlyph.char, { fg: options.titleGlyph.fg });
  else tx = canvas.gradFg(tx, titleRow, '✦', capFrom, capTo);
  const titleRoom = Math.max(1, r - escW - tx);
  tx = canvas.put(tx + 1, titleRow, clipText(options.title, titleRoom), { fg: t.text, bold: true });
  for (const crumb of options.crumbs ?? []) {
    if (tx + 4 > r - escW) break;
    canvas.put(tx + 1, titleRow, '›', { fg: t.textFaint });
    tx = canvas.put(tx + 3, titleRow, clipText(crumb, r - escW - tx - 3), { fg: t.textMuted });
  }
  if (options.sub && tx + 3 < r - escW) {
    tx = canvas.put(tx + 2, titleRow, clipText(options.sub, r - escW - tx - 2), { fg: t.textMuted });
  }
  if (options.escKey !== false) keycap(canvas, r - keycapWidth('esc') + 1, titleRow, 'esc');

  return {
    canvas,
    geometry,
    l,
    r,
    t: titleRow,
    top: titleRow + 2,
    bottom: Math.max(titleRow + 2, bottom),
    hintTop,
    hintRows,
    dim: options.dim !== false,
    hintRight: '',
  };
}

/** Draw the hint rows and return the layer for the compositor. */
export function finishModal(frame: ModalFrame): SurfaceLayer {
  const t = activeTokens();
  let lastEnd = frame.l;
  frame.hintRows.forEach((row, k) => { lastEnd = drawHintRow(frame.canvas, frame.l, frame.hintTop + k, row); });
  if (frame.hintRight) {
    frame.hintRight = fitCount(frame.hintRight, frame.r - frame.l + 1);
    const width = getDisplayWidth(frame.hintRight);
    const lastRow = frame.hintRows.length > 0 ? frame.hintTop + frame.hintRows.length - 1 : frame.hintTop;
    // On the last hint row when it fits beside the hints, else on the blank row above them.
    const fits = frame.hintRows.length === 0 || frame.r - width + 1 > lastEnd + 2;
    frame.canvas.right(frame.r, fits ? lastRow : frame.hintTop - 1, frame.hintRight, { fg: t.textFaint });
  }
  return {
    x: frame.geometry.x,
    y: frame.geometry.y - 1,
    lines: frame.canvas.lines,
    dim: frame.dim,
  };
}

// ---------------------------------------------------------------------------
// Search row
// ---------------------------------------------------------------------------

/**
 * The always-live search row: the typed text with a brand-colored ▏ cursor, or
 * the cursor and a faint placeholder when empty; an optional count on the right.
 */
export function searchRow(frame: ModalFrame, y: number, query: string, placeholder: string, countText?: string): void {
  let count = countText;
  const t = activeTokens();
  const { canvas, l, r } = frame;
  // A count wider than half the row gives way (the query matters more).
  const inner = r - l + 1;
  if (count && getDisplayWidth(count) > Math.floor(inner / 2)) count = fitCount(count, Math.floor(inner / 2));
  const countW = count ? getDisplayWidth(count) + 2 : 0;
  const room = Math.max(1, r - l + 1 - countW - 1);
  if (query.length > 0) {
    // Keep the end of a long query (where the cursor is) visible.
    const shown = tailText(query, room);
    const end = canvas.put(l, y, shown, { fg: t.text });
    canvas.put(end, y, '▏', { fg: t.brand });
  } else {
    canvas.put(l, y, '▏', { fg: t.brand });
    canvas.put(l + 1, y, clipText(placeholder, room - 1), { fg: t.textFaint });
  }
  if (count) canvas.right(r, y, count, { fg: t.textFaint });
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Fit a count or status ("12 more ↓", "3 of 5,582") into `width`: first the
 * words go ("12 ↓"), then it is cut. Counts are short on any real terminal;
 * this only matters on very narrow ones.
 */
function fitCount(text: string, width: number): string {
  if (getDisplayWidth(text) <= width) return text;
  const compact = text.replace(/\bmore\s+/g, '').replace(/\s*\blines?\b/g, '').replace(/\s+/g, ' ').trim();
  if (getDisplayWidth(compact) <= width) return compact;
  return clipText(compact, Math.max(0, width));
}

/** Cut `text` to at most `width` cells (no ellipsis; callers wrap instead where text matters). */
export function clipText(text: string, width: number): string {
  if (width <= 0) return '';
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/** The last `width` cells of `text`. */
export function tailText(text: string, width: number): string {
  const chars = [...text];
  let used = 0;
  let start = chars.length;
  while (start > 0) {
    const w = getDisplayWidth(chars[start - 1]!);
    if (used + w > width) break;
    used += w;
    start--;
  }
  return chars.slice(start).join('');
}

/** Wrap text to `width`, never returning an empty array. */
export function wrapLines(text: string, width: number): string[] {
  const lines = wrapText(text, Math.max(1, width));
  return lines.length > 0 ? lines : [''];
}

/** Draw wrapped text from (x, y) within `width`; returns the row after the last line. */
export function drawWrapped(canvas: SurfaceCanvas, x: number, y: number, width: number, text: string, style: KitStyle, maxY = Number.POSITIVE_INFINITY): number {
  let yy = y;
  for (const line of wrapLines(text, width)) {
    if (yy > maxY) break;
    canvas.put(x, yy, line, style);
    yy++;
  }
  return yy;
}
