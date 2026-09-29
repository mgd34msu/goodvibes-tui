/**
 * user-message.ts, a user message in the transcript.
 *
 *   col 2        ┃ in the bar color on every row, padding rows included
 *   cols 3..w-3  the panel fill, full width
 *   rows         one padding row, the text, one padding row
 *   text         from column 5, wrapped to width-9
 *
 * The composer is drawn the same way (composer.ts), so what you typed and
 * what you sent look alike.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';

const USER_MESSAGE_BAR_X = 2;
const USER_MESSAGE_FILL_X = 3;
const USER_MESSAGE_TEXT_X = 5;

export interface UserMessageStyle {
  readonly bar: string;
  readonly bg: string;
  readonly text: string;
  readonly strikethrough?: boolean;
}

function row(width: number, style: UserMessageStyle): Line {
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  if (width > USER_MESSAGE_BAR_X) {
    line[USER_MESSAGE_BAR_X] = { char: '┃', fg: style.bar, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  }
  for (let x = USER_MESSAGE_FILL_X; x <= width - 3; x++) {
    line[x] = { char: ' ', fg: style.text, bg: style.bg, bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  }
  return line;
}

export function renderUserMessage(text: string, width: number, style: UserMessageStyle): Line[] {
  const textWidth = Math.max(1, width - 9);
  const wrapped = wrapText(text, textWidth);
  const lines: Line[] = [row(width, style)];
  for (const content of wrapped.length > 0 ? wrapped : ['']) {
    const line = row(width, style);
    let x = USER_MESSAGE_TEXT_X;
    for (const ch of content) {
      const w = getDisplayWidth(ch);
      if (w <= 0) continue;
      if (x + w > width - 4) break;
      line[x] = { char: ch, fg: style.text, bg: style.bg, bold: false, dim: false, underline: false, italic: false, strikethrough: style.strikethrough ?? false };
      if (w === 2) line[x + 1] = { ...line[x]!, char: '' };
      x += w;
    }
    lines.push(line);
  }
  lines.push(row(width, style));
  return lines;
}
