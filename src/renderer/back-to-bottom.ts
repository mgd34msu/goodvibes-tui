/**
 * back-to-bottom.ts, the pill that shows while the output is scrolled away
 * from its live bottom, centered just above the input area:
 *
 *        ▐  ↓ Back to bottom   esc  ▌   (drawn as one filled row)
 *
 *   fill      the element surface, 2 columns of padding inside each end so
 *             the text never touches the fill's edge
 *   ↓         the brand color, bold
 *   words     "Back to bottom" in the text color
 *   keycap    ` esc ` on the keycap fill, 2 columns after the words, drawn
 *             only while the next Esc really goes back to the bottom (an
 *             empty composer, the keyboard in the input area); otherwise the
 *             pill names the place without a key, since the status line says
 *             what that Esc does instead
 *
 * It is a fill row, so it keeps one full empty row from any text above it
 * (the output, or the throbber); the input area's ▄ cap gives the half row
 * below it (shell-surface.ts builds that stack). Gone at the bottom.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';

/** What the pill shows. */
export interface BackToBottomState {
  /** The next Esc goes back to the live bottom: the pill carries the esc keycap. */
  readonly escKey: boolean;
}

const ARROW = '↓';
const WORDS = 'Back to bottom';
const KEY = 'esc';
/** Columns of fill between the pill's edge and its text. */
const PAD = 2;
/** Columns between the words and the keycap. */
const KEY_GAP = 2;

/** The pill's width in cells (with or without its keycap). */
function backToBottomWidth(state: BackToBottomState): number {
  const words = getDisplayWidth(ARROW) + 1 + getDisplayWidth(WORDS);
  return PAD + words + (state.escKey ? KEY_GAP + getDisplayWidth(KEY) + 2 : 0) + PAD;
}

/** The pill row, centered on a `width`-cell line (terminal background around it). */
export function renderBackToBottomPill(width: number, state: BackToBottomState): Line {
  const t = activeTokens();
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  // The keycap goes first when the row is short; the pill never runs past
  // the screen's 3-column margins (fills from column 3 to width-3).
  const withKey = state.escKey && backToBottomWidth(state) <= width - 6;
  const shape: BackToBottomState = { escKey: withKey };
  const pillW = Math.min(backToBottomWidth(shape), Math.max(0, width - 6));
  if (pillW < PAD * 2 + 1) return line;
  const x0 = Math.max(3, Math.floor((width - pillW) / 2));
  const x1 = x0 + pillW; // exclusive
  const bg = t.backgroundElement;
  for (let x = x0; x < x1; x++) line[x] = { ...line[x]!, char: ' ', bg };
  let cx = x0 + PAD;
  const put = (text: string, style: { fg: string; bg: string; bold?: boolean }): void => {
    for (const ch of text) {
      const w = getDisplayWidth(ch);
      if (w <= 0) continue;
      if (cx + w > x1 - PAD) return;
      line[cx] = { char: ch, fg: style.fg, bg: style.bg, bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
      if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
      cx += w;
    }
  };
  put(ARROW, { fg: t.brand, bg, bold: true });
  cx += 1;
  put(WORDS, { fg: t.text, bg });
  if (withKey) {
    cx += KEY_GAP;
    put(` ${KEY} `, { fg: t.text, bg: t.border, bold: true });
  }
  return line;
}
