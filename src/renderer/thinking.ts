/**
 * Render thinking/reasoning content with a dim purple left border.
 * Replaces the emoji-prefixed approach.
 */
import { type Line, createStyledCell, createEmptyLine } from '../types/grid.ts';
import { LAYOUT, BORDERS, COLORS } from './layout.ts';
import { wrapText } from '../utils/terminal-width.ts';

/**
 * Render a thinking block as Line[] with a colored left border.
 * The border character sits at column LEFT_MARGIN - 1 (col 3).
 * Text starts at column LEFT_MARGIN + 1 (col 5).
 */
export function renderThinkingBlock(text: string, width: number): Line[] {
  const lines: Line[] = [];
  const borderCol = LAYOUT.LEFT_MARGIN - 1;  // col 3
  const textStartCol = LAYOUT.LEFT_MARGIN + 1; // col 5
  const textWidth = width - textStartCol - LAYOUT.RIGHT_MARGIN;
  const borderStyle = BORDERS.THINKING;

  const wrapped = wrapText(text, textWidth);

  for (const lineText of wrapped) {
    const line = createEmptyLine(width);
    // Border character
    line[borderCol] = createStyledCell(borderStyle.char, { fg: borderStyle.color, dim: true });
    // Text
    let col = textStartCol;
    for (const ch of lineText) {
      if (col >= width - LAYOUT.RIGHT_MARGIN) break;
      line[col] = createStyledCell(ch, { fg: COLORS.DIM_TEXT, dim: true, italic: true });
      col++;
    }
    lines.push(line);
  }

  return lines;
}
