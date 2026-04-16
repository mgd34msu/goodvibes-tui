// ---------------------------------------------------------------------------
// buildStatusToken — always glyph + color, never color-only.
//
// Maps a semantic state to a Unicode glyph AND a palette color so that
// colorblind users and screen readers can distinguish states without color.
//
// Glyphs:
//   good  ✓  (CHECK MARK)
//   warn  ⚠  (WARNING SIGN)
//   bad   ✕  (MULTIPLICATION X)
//   info  ○  (WHITE CIRCLE)
// ---------------------------------------------------------------------------

import type { Cell } from '../types/grid.ts';
import { DEFAULT_PANEL_PALETTE } from '../panels/polish.ts';

export type StatusState = 'good' | 'warn' | 'bad' | 'info';

const STATE_GLYPHS: Record<StatusState, string> = {
  good: '\u2713', // ✓
  warn: '\u26a0', // ⚠
  bad:  '\u2715', // ✕
  info: '\u25cb', // ○
};

const STATE_COLORS: Record<StatusState, string> = {
  good: DEFAULT_PANEL_PALETTE.good,
  warn: DEFAULT_PANEL_PALETTE.warn,
  bad:  DEFAULT_PANEL_PALETTE.bad,
  info: DEFAULT_PANEL_PALETTE.info,
};

export interface StatusTokenOpts {
  /** Append a numeric count after the label, e.g. "label (3)". */
  count?: number;
  /** Override the default glyph for this state. */
  glyph?: string;
}

/**
 * Build a small sequence of styled cells: [glyph, space, label, optional count]
 *
 * Always prepends the glyph so colorblind users can parse the state.
 * The color is applied to both glyph and label as a redundant cue.
 *
 * @param state   Semantic state — controls default glyph and color.
 * @param label   Human-readable label string.
 * @param opts    Optional count suffix or glyph override.
 * @returns       Array of Cell objects ready to embed in a Line.
 */
export function buildStatusToken(
  state: StatusState,
  label: string,
  opts?: StatusTokenOpts,
): Cell[] {
  const glyph = opts?.glyph ?? STATE_GLYPHS[state];
  const color = STATE_COLORS[state];
  const suffix = opts?.count !== undefined ? ` (${opts.count})` : '';
  const text = `${glyph} ${label}${suffix}`;

  return text.split('').map((char): Cell => ({
    char,
    fg: color,
    bg: '',
    bold: false,
    dim: false,
    underline: false,
    italic: false,
    strikethrough: false,
  }));
}
