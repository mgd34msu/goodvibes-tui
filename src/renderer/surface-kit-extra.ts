/**
 * surface-kit-extra.ts, small shared helpers layered on the modal surface kit
 * (surface-kit.ts, surface-kit-list.ts, surface-kit-parts.ts) for surfaces
 * converted from the old ModalFactory / overlay-box frames:
 *
 *   - legacy hint strings ("r refresh", "Enter repair", "←/→ tab") become
 *     KitHint keycaps; strings that are not a key plus an action (for example
 *     "/health for latency & routes") are returned as notes to show as text
 *   - tab rows that wrap onto a second row instead of dropping tabs
 *   - content-sized modal heights (small dialogs grow to fit their body)
 *   - measuring a kit list's height, group spacing included
 *
 * Colors come only from the active theme's tokens.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import {
  MODAL_PAD_X,
  layoutHintRows,
  hintLayoutWidth,
  maxModalHeight,
  modalGeometry,
  wrapLines,
  type KitHint,
  type KitStyle,
  type ModalGeometryOptions,
  type SurfaceCanvas,
  type SurfaceLayer,
} from './surface-kit.ts';
import { isHeader, measureRow, type KitRow } from './surface-kit-list.ts';

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: '⏎',
  return: '⏎',
  esc: 'esc',
  escape: 'esc',
  tab: 'tab',
  'shift+tab': 'shift+tab',
  space: 'space',
  ' ': 'space',
  backspace: 'bksp',
  delete: 'del',
  del: 'del',
  pageup: 'pgup',
  pagedown: 'pgdn',
  pgup: 'pgup',
  pgdn: 'pgdn',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  'up/down': '↑↓',
  'left/right': '←→',
  '←/→': '←→',
  '↑/↓': '↑↓',
  '↑↓': '↑↓',
  '←→': '←→',
};

/** The keycap text for a key name ("enter" → "⏎", "Up/Down" → "↑↓", "d" → "d"). */
function keycapLabel(key: string): string {
  const lower = key.toLowerCase();
  const named = NAMED_KEYS[lower] ?? NAMED_KEYS[key];
  if (named) return named;
  if (/^(ctrl|shift|alt|meta)\+/i.test(key)) return lower;
  return key;
}

/** True when `token` reads as a key (a single character, a named key, a range like 1-6, a chord). */
function isKeyToken(token: string): boolean {
  if ([...token].length === 1) return true;
  const lower = token.toLowerCase();
  if (NAMED_KEYS[lower] !== undefined || NAMED_KEYS[token] !== undefined) return true;
  if (/^\d-\d$/.test(token)) return true;
  if (/^(ctrl|shift|alt|meta)\+\S+$/i.test(token)) return true;
  if (/^f\d{1,2}$/i.test(token)) return true;
  return false;
}

/** One legacy hint string as a keycap hint, or null when it is prose (a note). */
function hintFromString(text: string): KitHint | null {
  const trimmed = text.trim();
  // Legacy "[Enter] Load" style.
  const bracket = /^\[([^\]]+)\]\s+(.+)$/.exec(trimmed);
  if (bracket) return [keycapLabel(bracket[1]!), bracket[2]!];
  const space = trimmed.indexOf(' ');
  if (space <= 0) return null;
  const key = trimmed.slice(0, space);
  const action = trimmed.slice(space + 1).trim();
  if (!action || !isKeyToken(key)) return null;
  return [keycapLabel(key), action];
}

/**
 * Convert legacy hint strings into keycap hints plus notes. Hints whose key is
 * already present (earlier in `base` or the list) are dropped, so a surface
 * hint and the matching action hint show once.
 */
export function kitHintsFromStrings(
  strings: readonly string[],
  base: readonly KitHint[] = [],
): { readonly hints: KitHint[]; readonly notes: string[] } {
  const hints: KitHint[] = [...base];
  const notes: string[] = [];
  const seen = new Set(base.map(([key]) => key));
  for (const text of strings) {
    if (!text.trim()) continue;
    const hint = hintFromString(text);
    if (!hint) {
      if (!notes.includes(text.trim())) notes.push(text.trim());
      continue;
    }
    if (seen.has(hint[0])) continue;
    seen.add(hint[0]);
    hints.push(hint);
  }
  return { hints, notes };
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

/** Rows a kit list needs, the blank row above each group but the first included. */
export function listHeight(rows: readonly KitRow[], x0: number, x1: number): number {
  let total = 0;
  rows.forEach((row, k) => {
    total += measureRow(row, x0, x1);
    if (k > 0 && isHeader(row)) total += 1;
  });
  return total;
}

/**
 * The fill height a modal needs for `bodyRows` rows of body (from frame.top to
 * frame.bottom), given its hints, clamped to what the screen allows. Pass the
 * result as `height` to beginModal.
 */
export function modalHeightFor(
  screenW: number,
  screenH: number,
  options: ModalGeometryOptions & { readonly hints?: readonly KitHint[] },
  bodyRows: number,
): number {
  const g = modalGeometry(screenW, screenH, { width: options.width });
  const inner = Math.max(1, g.w - 2 * MODAL_PAD_X);
  const hintRows = options.hints && options.hints.length > 0
    ? layoutHintRows(options.hints, hintLayoutWidth(inner)).length
    : 0;
  // Fill rows: padding, title, blank, body..., [blank, hints...], padding.
  const need = hintRows > 0 ? bodyRows + hintRows + 5 : bodyRows + 4;
  return Math.max(5, Math.min(need, maxModalHeight(screenH)));
}

/** Text width between a modal's inner padding for a screen width (and optional preferred width). */
export function modalTextWidth(screenW: number, screenH: number, width?: number): number {
  const g = modalGeometry(screenW, screenH, { width });
  return Math.max(1, g.w - 2 * MODAL_PAD_X);
}

// ---------------------------------------------------------------------------
// Tabs that wrap
// ---------------------------------------------------------------------------

/** Rows `labels` take when laid out as tabs from x to maxX. */
export function tabRowCount(labels: readonly string[], x: number, maxX: number): number {
  return layoutTabs(labels, x, maxX).rows;
}

function layoutTabs(labels: readonly string[], x: number, maxX: number): { rows: number; at: Array<{ x: number; row: number }> } {
  const at: Array<{ x: number; row: number }> = [];
  let cx = x;
  let row = 0;
  labels.forEach((label, k) => {
    const w = getDisplayWidth(label);
    if (k > 0 && cx + w - 1 > maxX) {
      row++;
      cx = x;
    }
    at.push({ x: cx, row });
    cx += w + 4;
  });
  return { rows: labels.length === 0 ? 0 : row + 1, at };
}

/**
 * Tabs across one or more rows (a tab that does not fit moves to the next
 * row; none is dropped). The active tab carries the gradient with dark bold
 * text, the rest are muted. Returns the number of rows used.
 */
export function drawTabRows(canvas: SurfaceCanvas, x: number, y: number, labels: readonly string[], active: number, maxX: number): number {
  const t = activeTokens();
  const layout = layoutTabs(labels, x, maxX);
  labels.forEach((label, k) => {
    const pos = layout.at[k]!;
    const text = wrapLines(label, Math.max(1, maxX - pos.x + 1))[0] ?? label;
    const w = getDisplayWidth(text);
    if (k === active) {
      canvas.grad(pos.x - 1, y + pos.row, w + 2, t.brand, t.brandEnd);
      canvas.put(pos.x, y + pos.row, text, { fg: t.selectedListItemText, bold: true });
    } else {
      canvas.put(pos.x, y + pos.row, text, { fg: t.textMuted });
    }
  });
  return layout.rows;
}

// ---------------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------------

/** A block of text lines, each wrapped in full, with its own style. */
export interface TextLine {
  readonly text: string;
  readonly style?: KitStyle;
}

/** Wrapped row count of a text block. */
export function textBlockHeight(lines: readonly TextLine[], width: number): number {
  return lines.reduce((n, line) => n + (line.text === '' ? 1 : wrapLines(line.text, width).length), 0);
}

/** Draw a text block from row y (wrapping each line in full); returns the row after it. */
export function drawTextBlock(canvas: SurfaceCanvas, x: number, y: number, width: number, lines: readonly TextLine[], maxY = Number.POSITIVE_INFINITY): number {
  const t = activeTokens();
  let yy = y;
  for (const line of lines) {
    if (line.text === '') { yy++; continue; }
    for (const part of wrapLines(line.text, width)) {
      if (yy > maxY) return yy;
      canvas.put(x, yy, part, { fg: t.text, ...line.style });
      yy++;
    }
  }
  return yy;
}

// ---------------------------------------------------------------------------
// Two panes: a list on the left, an element panel on the right
// ---------------------------------------------------------------------------

/** Text width below which two-pane modals stack the panel under the list. */
const TWO_PANE_MIN_WIDTH = 60;

export interface PaneSplit {
  /** The list's text span and rows (inclusive). */
  readonly x0: number;
  readonly x1: number;
  readonly top: number;
  readonly bottom: number;
  /** The panel fill rectangle (text inside it keeps 2 columns of padding and a padding row). */
  readonly panelX: number;
  readonly panelY: number;
  readonly panelW: number;
  readonly panelH: number;
  readonly stacked: boolean;
}

/**
 * Split a modal body (rows top..bottom between text columns l..r) into a list
 * and an element panel. Wide bodies put the list on the left (`ratio` of the
 * width) and the panel on the right, reaching 2 columns from the fill's edge
 * like the concept's palette preview; narrow bodies stack the panel under the
 * list (`listRows` rows for the list, at least a third of the body).
 */
export function splitPanes(l: number, r: number, top: number, bottom: number, ratio = 0.45, listRows?: number): PaneSplit {
  const inner = r - l + 1;
  if (inner >= TWO_PANE_MIN_WIDTH) {
    const x1 = l + Math.max(20, Math.floor(inner * ratio)) - 1;
    return { x0: l, x1, top, bottom, panelX: x1 + 3, panelY: top, panelW: r - x1, panelH: bottom - top + 1, stacked: false };
  }
  const body = bottom - top + 1;
  const rows = Math.max(3, Math.min(listRows ?? Math.floor(body / 2), body - 5));
  const listBottom = top + rows - 1;
  return { x0: l, x1: r, top, bottom: listBottom, panelX: l - 2, panelY: listBottom + 2, panelW: inner + 4, panelH: bottom - listBottom - 1, stacked: true };
}

// ---------------------------------------------------------------------------
// Layers as plain lines
// ---------------------------------------------------------------------------

/**
 * A layer's cells placed on `height` blank lines of `width` columns, with no
 * dimming (for a surface that owns the whole viewport, such as onboarding).
 */
export function layerToLines(layer: SurfaceLayer, width: number, height: number): Line[] {
  const lines: Line[] = Array.from({ length: height }, () => createEmptyLine(width));
  layer.lines.forEach((row, r) => {
    const target = lines[layer.y + r];
    if (!target) return;
    row.forEach((cell, c) => {
      const x = layer.x + c;
      if (x >= 0 && x < width) target[x] = { ...cell };
    });
  });
  return lines;
}
