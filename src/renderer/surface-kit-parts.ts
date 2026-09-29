/**
 * surface-kit-parts.ts, the smaller pieces of the modal surface kit:
 *
 *   - element panels (a lighter fill inside a modal: 2 columns of side padding,
 *     a padding row above and below)
 *   - tabs (the active tab carries the gradient)
 *   - button chips (arrows pick, Enter confirms; the danger chip is red)
 *   - meters (▰▱)
 *   - toasts (top right, a colored ┃ on both sides, wrapped text)
 *   - composer popups (the slash and @ lists: anchored to the composer, no dim,
 *     ┃ bar, surface fill, selected row gradient, no frame and no hint rows)
 *
 * Colors come only from the active theme's tokens.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import {
  SurfaceCanvas,
  clipText,
  type KitHint,
  transparentCell,
  wrapLines,
  type KitStyle,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, drawRow, drawScrollingList, measureRow, type KitListResult, type KitRow } from './surface-kit-list.ts';

// ---------------------------------------------------------------------------
// Element panels
// ---------------------------------------------------------------------------

/** Side padding inside a panel. */
const PANEL_PAD_X = 2;

export interface KitPanel {
  /** Panel fill rectangle (canvas coordinates). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Text area: columns l..r, rows top..bottom (inclusive). */
  readonly l: number;
  readonly r: number;
  readonly top: number;
  readonly bottom: number;
  readonly bg: string;
}

/** Fill a lighter element panel and return its text area. */
export function panel(canvas: SurfaceCanvas, x: number, y: number, w: number, h: number, bg = activeTokens().backgroundElement): KitPanel {
  canvas.fill(x, y, w, h, bg);
  return {
    x, y, w, h, bg,
    l: x + PANEL_PAD_X,
    r: x + w - 1 - PANEL_PAD_X,
    top: y + 1,
    bottom: y + h - 2,
  };
}

/** Put text inside a panel (keeps the panel bg). Returns the column after it. */
export function panelPut(canvas: SurfaceCanvas, p: KitPanel, x: number, y: number, text: string, style: KitStyle = {}): number {
  if (y < p.top || y > p.bottom) return x;
  return canvas.put(x, y, clipText(text, p.r - x + 1), { ...style, bg: p.bg });
}

/** Wrapped text inside a panel from row y; returns the row after the last line drawn. */
export function panelWrap(canvas: SurfaceCanvas, p: KitPanel, x: number, y: number, text: string, style: KitStyle = {}): number {
  let yy = y;
  for (const line of wrapLines(text, p.r - x + 1)) {
    if (yy > p.bottom) break;
    canvas.put(x, yy, line, { ...style, bg: p.bg });
    yy++;
  }
  return yy;
}

/** One line of panel text. */
export interface PanelLine { readonly text: string; readonly style: KitStyle }

/**
 * Wrap and draw paragraphs inside a panel from row y. When they do not all
 * fit, the last visible row says how many lines are hidden instead of the text
 * stopping silently. Returns the row after the last one drawn.
 */
export function panelLines(canvas: SurfaceCanvas, p: KitPanel, x: number, y: number, paragraphs: readonly PanelLine[]): number {
  const t = activeTokens();
  const lines: PanelLine[] = [];
  for (const para of paragraphs) {
    if (para.text === '') lines.push(para);
    else for (const text of wrapLines(para.text, p.r - x + 1)) lines.push({ text, style: para.style });
  }
  const room = Math.max(0, p.bottom - y + 1);
  const overflow = lines.length > room;
  const shown = overflow ? lines.slice(0, Math.max(0, room - 1)) : lines;
  let yy = y;
  for (const line of shown) canvas.put(x, yy++, line.text, { ...line.style, bg: p.bg });
  if (overflow && room > 0) canvas.put(x, yy++, `${lines.length - shown.length} more lines`, { fg: t.textFaint, bg: p.bg });
  return yy;
}

// ---------------------------------------------------------------------------
// Keycap hints in a plain row (bars and status rows outside a modal)
// ---------------------------------------------------------------------------

/** Display width of a row of keycap hints (3 columns between hints). */
export function keycapHintsWidth(hints: readonly KitHint[]): number {
  return hints.reduce((sum, [key, action], i) => sum + (i > 0 ? 3 : 0) + getDisplayWidth(key) + 3 + getDisplayWidth(action), 0);
}

/**
 * Paint keycap hints into a Line from column x (each key a bold chip on the
 * keycap fill, its action in `actionStyle`), the same look as a modal's hint
 * row. Hints that do not fit before `endX` are left out whole, never cut.
 * Returns the column after the last hint drawn.
 */
export function paintKeycapHints(line: Line, x: number, endX: number, hints: readonly KitHint[], actionStyle: { readonly fg: string; readonly bg?: string }): number {
  const t = activeTokens();
  let cx = x;
  const put = (text: string, style: { fg: string; bg?: string; bold?: boolean }): void => {
    for (const ch of text) {
      const w = getDisplayWidth(ch);
      if (cx + w > endX || cx >= line.length) return;
      const prev = line[cx]!;
      line[cx] = { ...prev, char: ch, fg: style.fg, bg: style.bg ?? prev.bg, bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
      if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
      cx += w;
    }
  };
  hints.forEach(([key, action], i) => {
    const need = (i > 0 ? 3 : 0) + getDisplayWidth(key) + 3 + getDisplayWidth(action);
    if (cx + need > endX) return;
    if (i > 0) cx += 3;
    put(` ${key} `, { fg: t.text, bg: t.border, bold: true });
    cx += 1;
    put(action, { fg: actionStyle.fg, bg: actionStyle.bg });
  });
  return cx;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Tabs across a row; the active one carries the gradient with dark bold text. Returns the column after the last tab. */
export function tabs(canvas: SurfaceCanvas, x: number, y: number, labels: readonly string[], active: number, maxX: number): number {
  const t = activeTokens();
  let cx = x;
  labels.forEach((label, k) => {
    const w = getDisplayWidth(label);
    if (cx + w > maxX) return;
    if (k === active) {
      canvas.grad(cx - 1, y, w + 2, t.brand, t.brandEnd);
      canvas.put(cx, y, label, { fg: t.selectedListItemText, bold: true });
    } else {
      canvas.put(cx, y, label, { fg: t.textMuted });
    }
    cx += w + 4;
  });
  return cx;
}

// ---------------------------------------------------------------------------
// Buttons, chips and meters
// ---------------------------------------------------------------------------

export type ButtonTone = 'primary' | 'warning' | 'danger';

/** A button chip. The chosen one is filled in its tone with dark bold text; the rest are quiet chips (the keycap fill). */
export function button(canvas: SurfaceCanvas, x: number, y: number, label: string, chosen: boolean, tone: ButtonTone = 'primary'): number {
  const t = activeTokens();
  const toneBg = tone === 'danger' ? t.error : tone === 'warning' ? t.warning : t.brand;
  const style: KitStyle = chosen
    ? { fg: t.selectedListItemText, bg: toneBg, bold: true }
    : { fg: t.textMuted, bg: t.border };
  return canvas.put(x, y, ` ${label} `, style);
}

/** Width of a button chip. */
export function buttonWidth(label: string): number {
  return getDisplayWidth(label) + 2;
}

/** A small colored chip (e.g. a risk level). */
export function chip(canvas: SurfaceCanvas, x: number, y: number, label: string, bg: string): number {
  const t = activeTokens();
  return canvas.put(x, y, ` ${label} `, { fg: t.selectedListItemText, bg, bold: true });
}

/** A 10-step meter (▰ filled, ▱ empty) in `color`. Returns the column after it. */
export function meter(canvas: SurfaceCanvas, x: number, y: number, fraction: number, color: string, bg?: string): number {
  const t = activeTokens();
  const n = Math.max(0, Math.min(10, Math.round(fraction * 10)));
  let cx = x;
  for (let q = 0; q < 10; q++) cx = canvas.put(cx, y, q < n ? '▰' : '▱', { fg: q < n ? color : t.border, bg });
  return cx;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastSpec {
  readonly title: string;
  readonly body?: string;
  readonly tone: ToastTone;
}

function toastToneColor(tone: ToastTone): string {
  const t = activeTokens();
  return tone === 'error' ? t.error : tone === 'warning' ? t.warning : tone === 'success' ? t.success : t.info;
}

/** Width of a toast on a screen of width screenW. */
function toastWidth(screenW: number): number {
  return Math.max(20, Math.min(50, screenW - 4));
}

/**
 * Toasts stacked in the top right corner (below the header row), newest first.
 * Each toast: ┃ in its tone on both sides, a padding row above and below, the
 * title bold, the body muted and wrapped in full.
 */
export function renderToasts(screenW: number, screenH: number, toasts: readonly ToastSpec[]): SurfaceLayer | null {
  if (toasts.length === 0 || screenW < 24 || screenH < 6) return null;
  const t = activeTokens();
  const w = toastWidth(screenW);
  const textW = w - 6;
  const blocks = toasts.map((toast) => {
    const lines = [
      ...wrapLines(toast.title, textW).map((text) => ({ text, bold: true, fg: t.text })),
      ...(toast.body ? wrapLines(toast.body, textW).map((text) => ({ text, bold: false, fg: t.textMuted })) : []),
    ];
    return { toast, lines, h: lines.length + 2 };
  });
  const maxH = screenH - 3;
  let total = 0;
  const shown: typeof blocks = [];
  for (const block of blocks) {
    const need = total + (shown.length > 0 ? 1 : 0) + block.h;
    if (need > maxH) break;
    shown.push(block);
    total = need;
  }
  if (shown.length === 0) return null;
  const canvas = new SurfaceCanvas(w, total);
  let y = 0;
  shown.forEach((block, k) => {
    if (k > 0) y++;
    const bar = toastToneColor(block.toast.tone);
    for (let r = 0; r < block.h; r++) {
      canvas.fill(0, y + r, w, 1, t.backgroundPanel);
      canvas.put(0, y + r, '┃', { fg: bar });
      canvas.put(w - 1, y + r, '┃', { fg: bar });
    }
    block.lines.forEach((line, i) => canvas.put(3, y + 1 + i, line.text, { fg: line.fg, bold: line.bold }));
    y += block.h;
  });
  // Rows between stacked toasts keep what is underneath.
  for (const line of canvas.lines) {
    for (let q = 0; q < line.length; q++) if (line[q]!.bg === '' && line[q]!.char === ' ') line[q] = transparentCell();
  }
  return { x: screenW - w - 2, y: 1, lines: canvas.lines, dim: false };
}

// ---------------------------------------------------------------------------
// Composer popups (slash commands, @ files)
// ---------------------------------------------------------------------------

/** Column of the popup's ┃ bar (the composer's own left edge). */
export const POPUP_BAR_X = 2;

export interface PopupOptions {
  /** Width of the lines to produce (the conversation width). */
  readonly width: number;
  readonly rows: readonly KitRow[];
  /** A row pinned above the list (it never scrolls away), e.g. the typed query. */
  readonly header?: KitRow;
  /** Maximum rows the content may use (padding rows excluded). */
  readonly maxRows: number;
  /** Remembers the list's scroll position between renders (the picker's state object). */
  readonly scrollOwner?: object;
}

export interface PopupResult {
  readonly lines: Line[];
  readonly list: KitListResult;
}

/**
 * A composer popup: the ┃ bar at column 2 in the faint color, a surface fill
 * from column 3 to width-3 with a padding row above and below, text from
 * column 5 and right-aligned text ending 2 columns inside the fill. Returns
 * full-width lines (cells left of the bar and right of the fill are empty)
 * for docking right above the composer. A list longer than the popup keeps
 * the selected row in view and says what is hidden on its last row.
 */
export function renderPopup(options: PopupOptions): PopupResult {
  const t = activeTokens();
  const { width } = options;
  const fillX = POPUP_BAR_X + 1;
  const fillW = Math.max(6, width - fillX - 2);
  const x0 = fillX + 2;
  const x1 = fillX + fillW - 3;
  const headerRows = options.header ? measureRow(options.header, x0, x1) : 0;
  const listMax = Math.max(1, options.maxRows - headerRows);
  const scrollKey = options.scrollOwner ? { owner: options.scrollOwner, name: 'popup' } : undefined;
  // Measure on a scratch canvas: how many rows the list really needs.
  const trial = drawList(new SurfaceCanvas(width, listMax + 1), { rows: options.rows, top: 0, bottom: listMax - 1, x0, x1, scrollKey });
  const overflow = trial.above > 0 || trial.below > 0;
  const listUsed = overflow ? listMax : Math.max(1, trial.endY);
  const used = headerRows + listUsed;
  const canvas = new SurfaceCanvas(width, used + 2);
  canvas.fill(fillX, 0, fillW, used + 2, t.backgroundPanel);
  if (options.header) drawRow(canvas, 1, options.header, x0, x1);
  const listOptions = { rows: options.rows, top: 1 + headerRows, bottom: used, x0, x1, scrollKey };
  const list = overflow ? drawScrollingList(canvas, listOptions) : drawList(canvas, listOptions);
  for (let r = 0; r < used + 2; r++) canvas.put(POPUP_BAR_X, r, '┃', { fg: t.textFaint });
  return { lines: canvas.lines, list };
}
