/**
 * Render system messages with typed left borders.
 * Error = red, Warning = yellow, Info = cyan.
 */
import { type Line, createStyledCell, createEmptyLine } from '../types/grid.ts';
import { LAYOUT, BORDERS, COLORS } from './layout.ts';
import { wrapText } from '../utils/terminal-width.ts';

type SystemMessageType = 'error' | 'warning' | 'info';

function classifySystemMessage(content: string): SystemMessageType {
  if (/error|failed|denied|crash|exception/i.test(content)) return 'error';
  if (/warning|context usage|caution|deprecated/i.test(content)) return 'warning';
  return 'info';
}

/**
 * Render a system message with a colored left border.
 */
export function renderSystemMessage(
  content: string,
  width: number,
  typeOverride?: 'error' | 'warning' | 'info',
): Line[] {
  const lines: Line[] = [];
  const msgType = typeOverride ?? classifySystemMessage(content);
  const border = msgType === 'error' ? BORDERS.ERROR
    : msgType === 'warning' ? BORDERS.WARNING
    : BORDERS.INFO;

  const borderCol = LAYOUT.LEFT_MARGIN - 1;
  const textStartCol = LAYOUT.LEFT_MARGIN + 1;
  const textWidth = width - textStartCol - LAYOUT.RIGHT_MARGIN;
  const textColor = msgType === 'info' ? COLORS.DIM_TEXT : border.color;
  const dim = msgType === 'info';

  const wrapped = wrapText(content, textWidth);

  for (const lineText of wrapped) {
    const line = createEmptyLine(width);
    line[borderCol] = createStyledCell(border.char, { fg: border.color });
    let col = textStartCol;
    for (const ch of lineText) {
      if (col >= width - LAYOUT.RIGHT_MARGIN) break;
      line[col] = createStyledCell(ch, { fg: textColor, dim });
      col++;
    }
    lines.push(line);
  }

  return lines;
}
