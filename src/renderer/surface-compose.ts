/**
 * surface-compose.ts, the compositor's two modal passes.
 *
 * Dim pass: after the screen is composed, every cell's foreground and
 * background blend toward a scrim color (dark themes: black at 0.62; light
 * themes: the text color at 0.38, a lighter scrim). A cell on the terminal's
 * own background (bg '') blends against the probed terminal background, or a
 * theme-derived stand-in when the terminal did not answer the probe. Bold is
 * dropped so nothing behind the modal competes with it.
 *
 * Stamp over: a SurfaceLayer is drawn over the (dimmed) screen at its own
 * position instead of replacing whole rows; cells outside its rectangle keep
 * their dimmed content. Layer cells with bg '' keep the bg underneath (the
 * half-block caps), transparent cells are skipped, and a wide character cut by
 * the layer's edge is blanked so no half glyph is left behind.
 *
 * The passes work on any CellGrid, so the compositor (TerminalBuffer) and the
 * golden-frame tests (plain Line[]) share them.
 */

import { createEmptyCell, type Cell } from '@pellux/goodvibes-sdk/platform/types';
import { ansiToHex, isHexColor, mixHex, normalizeHex } from '@pellux/goodvibes-sdk/platform/presentation';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { getTerminalPalette } from './terminal-palette.ts';
import { activeThemeMode, activeTokens } from './theme.ts';
import { isTransparentCell, type SurfaceLayer } from './surface-kit.ts';

export interface CellGrid {
  readonly width: number;
  readonly height: number;
  getCell(x: number, y: number): Cell | undefined;
  setCell(x: number, y: number, cell: Cell): void;
}

export interface DimParams {
  /** The color everything blends toward. */
  readonly scrim: string;
  /** Blend amount, 0..1. */
  readonly amount: number;
  /** What an empty bg means on this terminal. */
  readonly terminalBg: string;
  /** What an empty fg means on this terminal. */
  readonly terminalFg: string;
}

/** Dim amount on dark themes (about 60% toward black). */
const DARK_DIM_AMOUNT = 0.62;
/** Dim amount on light themes (a lighter scrim). */
const LIGHT_DIM_AMOUNT = 0.38;

/** The dim parameters for the active theme, mode and probed terminal colors. */
function currentDimParams(): DimParams {
  const t = activeTokens();
  const mode = activeThemeMode();
  const palette = getTerminalPalette();
  const black = ansiToHex(0);
  const white = ansiToHex(15);
  const terminalBg = hexOr(palette?.background, t.background)
    ?? (mode === 'dark' ? mixHex(t.backgroundBase, black, 0.3) : white);
  const terminalFg = hexOr(palette?.foreground, undefined) ?? t.text;
  return mode === 'dark'
    ? { scrim: black, amount: DARK_DIM_AMOUNT, terminalBg, terminalFg }
    : { scrim: t.text, amount: LIGHT_DIM_AMOUNT, terminalBg, terminalFg };
}

function hexOr(a: string | undefined, b: string | undefined): string | undefined {
  if (a && isHexColor(a)) return normalizeHex(a);
  if (b && isHexColor(b)) return normalizeHex(b);
  return undefined;
}

/** '#rgb' / '#rrggbb' / 'r;g;b' to '#rrggbb'; undefined for anything else (including ''). */
function toHexColor(color: string): string | undefined {
  if (!color) return undefined;
  if (color.startsWith('#')) return isHexColor(color) ? normalizeHex(color) : undefined;
  const parts = color.split(';');
  if (parts.length === 3 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    return `#${parts.map((p) => Math.min(255, Number(p)).toString(16).padStart(2, '0')).join('')}`;
  }
  return undefined;
}

/** Blend every cell of the grid toward the scrim. */
function dimGrid(grid: CellGrid, params: DimParams): void {
  const cache = new Map<string, string>();
  const blend = (color: string, fallback: string): string => {
    const key = color || `default:${fallback}`;
    let out = cache.get(key);
    if (out === undefined) {
      out = mixHex(toHexColor(color) ?? fallback, params.scrim, params.amount);
      cache.set(key, out);
    }
    return out;
  };
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.getCell(x, y);
      if (!cell) continue;
      grid.setCell(x, y, {
        ...cell,
        fg: blend(cell.fg, params.terminalFg),
        bg: blend(cell.bg, params.terminalBg),
        bold: false,
      });
    }
  }
}

/** Stamp one layer over the grid. */
function stampLayer(grid: CellGrid, layer: SurfaceLayer): void {
  for (let r = 0; r < layer.lines.length; r++) {
    const y = layer.y + r;
    if (y < 0 || y >= grid.height) continue;
    const line = layer.lines[r]!;
    let firstX = -1;
    let lastX = -1;
    for (let q = 0; q < line.length; q++) {
      const x = layer.x + q;
      if (x < 0 || x >= grid.width) continue;
      const cell = line[q]!;
      if (isTransparentCell(cell)) continue;
      const under = grid.getCell(x, y);
      grid.setCell(x, y, { ...cell, bg: cell.bg !== '' ? cell.bg : under?.bg ?? '' });
      if (firstX < 0) firstX = x;
      lastX = x;
    }
    if (firstX < 0) continue;
    // A wide glyph whose right half the layer covered: blank its left half.
    const left = grid.getCell(firstX - 1, y);
    if (left && left.char !== '' && getDisplayWidth(left.char) > 1) grid.setCell(firstX - 1, y, { ...left, char: ' ' });
    // A continuation cell whose wide glyph the layer covered: make it a plain space.
    const right = grid.getCell(lastX + 1, y);
    if (right && right.char === '') grid.setCell(lastX + 1, y, { ...createEmptyCell(), bg: right.bg, fg: right.fg });
  }
}

/**
 * Apply layers in order, bottom first. A layer that asks for dimming dims
 * everything under it (the screen, and any modal below it: a confirm dialog
 * over a modal puts that modal in the background too); layers that do not
 * dim (toasts, popups) are stamped as they are.
 */
export function composeLayers(grid: CellGrid, layers: readonly SurfaceLayer[], params: DimParams = currentDimParams()): void {
  for (const layer of layers) {
    if (layer.dim) dimGrid(grid, params);
    stampLayer(grid, layer);
  }
}
