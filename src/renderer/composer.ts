/**
 * composer.ts, the prompt box, built exactly like a user message. It holds
 * input and nothing else.
 *
 *   col 2        ┃ in the mode color, on every row of the block
 *   cols 3..w-3  the element fill
 *   rows         padding, text (one or more), padding
 *   text         from column 5, wrapped to width-9 (see prompt-content-width.ts)
 *
 * Multi-line input grows the text area; nothing else moves. The approval mode,
 * the auto-approve warning and the safety chips are on the status line; the
 * model and the failover marker are in the header.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { GLYPHS } from './ui-primitives.ts';
import { activeTokens } from './theme.ts';

/** Column of the mode bar. */
const COMPOSER_BAR_X = 2;
/** First fill column. */
const COMPOSER_FILL_X = 3;
/** First text column. */
const COMPOSER_TEXT_X = 5;
/** Rows the composer adds around its text rows (the padding row above and below). */
export const COMPOSER_FIXED_ROWS = 2;

const COMPOSER_PLACEHOLDER = 'Ask anything, or type / for commands and @ for files';

export interface ComposerOptions {
  readonly width: number;
  /** Visible prompt rows joined with '\n'. */
  readonly promptText: string;
  /** Cursor offset into promptText (rows joined with one separator), when on screen. */
  readonly cursorPos?: number;
  readonly focused: boolean;
  /** Shown instead of the placeholder while another surface owns the keyboard. */
  readonly unfocusedHint?: string;
  /** Faint hint after the cursor on the last row (a command's arguments). */
  readonly argsHint?: string;
  /** The bar's color: the session mode (brand, plan, auto-approving modes, shell), or the agent or process shown. */
  readonly modeColor: string;
  /** The empty composer's placeholder (an agent view: "Message engineer. This steers it; main keeps running."). */
  readonly placeholder?: string;
  /**
   * The composer takes no input here; the reason is drawn in its place (a
   * process whose stdin is not reachable). No cursor is drawn.
   */
  readonly disabledReason?: string;
}

interface Style { readonly fg: string; readonly bg: string; readonly bold?: boolean }

function put(line: Line, x: number, endX: number, text: string, style: Style): number {
  let cx = x;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX) break;
    line[cx] = { char: ch, fg: style.fg, bg: style.bg, bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

function blockRow(width: number, bar: string, bg: string): Line {
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  if (width > COMPOSER_BAR_X) line[COMPOSER_BAR_X] = { char: '┃', fg: bar, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  for (let x = COMPOSER_FILL_X; x <= width - 3; x++) line[x] = { char: ' ', fg: '', bg, bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  return line;
}

/** Render the composer block (at least 3 rows). */
export function renderComposer(options: ComposerOptions): Line[] {
  const t = activeTokens();
  const { width } = options;
  const bg = t.backgroundElement;
  const bar = options.modeColor;
  const textEnd = width - 4; // exclusive: text keeps 2 columns from the fill's right edge
  if (options.disabledReason !== undefined) {
    const line = blockRow(width, bar, bg);
    put(line, COMPOSER_TEXT_X, textEnd, truncateDisplay(options.disabledReason, Math.max(0, textEnd - COMPOSER_TEXT_X)), { fg: t.textFaint, bg });
    return [blockRow(width, bar, bg), line, blockRow(width, bar, bg)];
  }
  const rows = options.promptText.split('\n');
  const lines: Line[] = [blockRow(width, bar, bg)];
  const textFg = options.focused ? t.text : t.textFaint;
  const placeholder = options.placeholder ?? COMPOSER_PLACEHOLDER;

  let offset = 0;
  rows.forEach((text, i) => {
    const line = blockRow(width, bar, bg);
    const last = i === rows.length - 1;
    const empty = rows.length === 1 && text === '';
    if (empty) {
      const hint = options.focused ? placeholder : (options.unfocusedHint ?? placeholder);
      put(line, COMPOSER_TEXT_X, textEnd, truncateDisplay(hint, Math.max(0, textEnd - COMPOSER_TEXT_X)), { fg: t.textFaint, bg });
    } else {
      put(line, COMPOSER_TEXT_X, textEnd + 1, text, { fg: textFg, bg });
    }
    if (options.focused) {
      const posInRow = options.cursorPos !== undefined ? options.cursorPos - offset : (last ? text.length : -1);
      if (posInRow >= 0 && posInRow <= text.length && (options.cursorPos !== undefined || last)) {
        const cx = COMPOSER_TEXT_X + getDisplayWidth(text.slice(0, posInRow));
        if (cx <= width - 4) {
          const cell = line[cx]!;
          const blank = empty || cell.char === ' ' || cell.char === '';
          line[cx] = blank && !empty
            ? { ...cell, char: GLYPHS.surface.cursor, fg: t.text, bg }
            : { ...cell, char: cell.char === '' ? ' ' : cell.char, fg: bg, bg: t.text };
          // A command's argument hint trails the cursor while it sits at the end.
          if (last && options.argsHint && posInRow >= text.length && !empty) {
            put(line, cx + 2, textEnd, truncateDisplay(options.argsHint, Math.max(0, textEnd - cx - 2)), { fg: t.textFaint, bg });
          }
        }
      }
    }
    offset += text.length + 1;
    lines.push(line);
  });

  lines.push(blockRow(width, bar, bg));
  return lines;
}
