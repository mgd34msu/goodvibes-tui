/**
 * composer.ts, the prompt box, built exactly like a user message.
 *
 *   col 2        ┃ in the mode color, on every row of the block
 *   cols 3..w-3  the element fill
 *   rows         padding, text (one or more), padding, inner row, padding
 *   text         from column 5, wrapped to width-9 (see prompt-content-width.ts)
 *   inner row    mode · model provider [failover marker] [flags] on the left,
 *                the always-visible safety chips right-aligned inside the fill
 *                (ending at width-5): the live microphone, "sleep disabled",
 *                and the auto-approve warning in the error color.
 *
 * Multi-line input grows the text area; nothing else moves.
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
/** Rows the composer adds around its text rows (padding, padding, inner row, padding). */
export const COMPOSER_FIXED_ROWS = 4;

const COMPOSER_PLACEHOLDER = 'Ask anything, or type / for commands and @ for files';

export interface ComposerChip {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  /** A filled chip (the wake indicator's banner prominence); the fill otherwise. */
  readonly bg?: string;
  /** Never dropped for lack of room (the auto-approve warning). */
  readonly keep?: boolean;
}

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
  readonly modeLabel: string;
  readonly modeColor: string;
  readonly model?: string;
  readonly provider?: string;
  /** The failover marker, set only while serving differs from the configured model. */
  readonly modelNote?: string;
  /** Faint extra words after the model (attachments, orchestration), each optionally colored. */
  readonly flags?: readonly (string | { readonly text: string; readonly fg: string })[];
  /** Right-aligned chips, highest priority first. */
  readonly chips?: readonly ComposerChip[];
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

/** Render the composer block (at least 5 rows). */
export function renderComposer(options: ComposerOptions): Line[] {
  const t = activeTokens();
  const { width } = options;
  const bg = t.backgroundElement;
  const bar = options.modeColor;
  const textEnd = width - 4; // exclusive: text keeps 2 columns from the fill's right edge
  const rows = options.promptText.split('\n');
  const lines: Line[] = [blockRow(width, bar, bg)];
  const textFg = options.focused ? t.text : t.textFaint;

  let offset = 0;
  rows.forEach((text, i) => {
    const line = blockRow(width, bar, bg);
    const last = i === rows.length - 1;
    const empty = rows.length === 1 && text === '';
    if (empty) {
      const hint = options.focused ? COMPOSER_PLACEHOLDER : (options.unfocusedHint ?? COMPOSER_PLACEHOLDER);
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

  // Inner row: mode · model provider, then the chips right-aligned.
  const inner = blockRow(width, bar, bg);
  const innerEnd = width - 4; // exclusive
  const chips = [...(options.chips ?? [])];
  const chipsWidth = (list: readonly ComposerChip[]): number => list.reduce((s, c, i) => s + (i > 0 ? 2 : 0) + getDisplayWidth(c.text), 0);
  const leftMin = getDisplayWidth(options.modeLabel) + 2;
  // Drop the lowest-priority chips that do not fit; a kept chip always stays.
  while (chips.length > 0 && COMPOSER_TEXT_X + leftMin + 3 + chipsWidth(chips) > innerEnd) {
    const idx = [...chips].reverse().findIndex((c) => !c.keep);
    if (idx < 0) break;
    chips.splice(chips.length - 1 - idx, 1);
  }
  const rightW = chipsWidth(chips);
  const leftLimit = Math.max(COMPOSER_TEXT_X, innerEnd - rightW - (rightW > 0 ? 3 : 0));
  let x = put(inner, COMPOSER_TEXT_X, leftLimit, options.modeLabel, { fg: bar, bg, bold: true });
  // `whole` segments fit entirely, fall back to their short form, or are
  // dropped: a half-cut failover marker reads worse than none (what remains is
  // still the serving backend, never a claim about the configured one).
  const segments: Array<{ text: string; fg: string; whole?: boolean; short?: string }> = [];
  if (options.model) {
    segments.push({ text: ' · ', fg: t.textFaint });
    segments.push({ text: options.model, fg: t.text });
    if (options.provider) segments.push({ text: ` ${options.provider}`, fg: t.textFaint });
  }
  if (options.modelNote) segments.push({ text: ` · ${options.modelNote}`, fg: t.warning, whole: true, short: ' · divergent' });
  for (const flag of options.flags ?? []) {
    segments.push(typeof flag === 'string' ? { text: ` · ${flag}`, fg: t.textFaint } : { text: ` · ${flag.text}`, fg: flag.fg, whole: true });
  }
  for (const seg of segments) {
    const room = leftLimit - x;
    if (room <= 0) break;
    let text = seg.text;
    if (getDisplayWidth(text) > room) {
      if (!seg.whole) text = truncateDisplay(text, room);
      else if (seg.short && getDisplayWidth(seg.short) <= room) text = seg.short;
      else continue;
    }
    x = put(inner, x, leftLimit, text, { fg: seg.fg, bg });
  }
  let cx = innerEnd - rightW;
  chips.forEach((chip, i) => {
    if (i > 0) cx += 2;
    cx = put(inner, Math.max(COMPOSER_TEXT_X, cx), innerEnd, chip.text, { fg: chip.fg, bg: chip.bg ?? bg, bold: chip.bold });
  });
  lines.push(inner);
  lines.push(blockRow(width, bar, bg));
  return lines;
}
