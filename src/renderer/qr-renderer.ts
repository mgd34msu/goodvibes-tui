import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { generateQrMatrix } from '@pellux/goodvibes-sdk/platform/pairing';

export { generateQrMatrix };

/**
 * Render a QR boolean matrix to terminal Lines using Unicode half-block characters.
 *
 * Two matrix rows map to one terminal row:
 *   top=dark, bottom=dark  → '█'  (FULL BLOCK)
 *   top=dark, bottom=light → '▀'  (UPPER HALF BLOCK)
 *   top=light, bottom=dark → '▄'  (LOWER HALF BLOCK)
 *   top=light, bottom=light → ' ' (SPACE)
 *
 * @param modules - 2D boolean matrix where true = dark module
 * @param width   - Terminal width available for centering
 * @param options - Optional fg/bg overrides
 */
export function renderQrMatrix(
  modules: readonly boolean[][],
  width: number,
  options?: { fg?: string; bg?: string },
): Line[] {
  const fg = options?.fg ?? '#000000';
  const bg = options?.bg ?? '#ffffff';

  const rows = modules.length;
  const cols = modules[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return [];

  // Each terminal row covers two matrix rows
  const terminalRows = Math.ceil(rows / 2);
  // Left-align with a single-cell indent. Visually aligns with the text above
  // the QR when rendered with half-block characters; bumping higher
  // mis-registers the finder patterns by a visible unit.
  const leftPad = 1;

  const lines: Line[] = [];

  // Prepend a half-height top quiet band: the BOTTOM half of this terminal row
  // is white (QR bg) flush against the QR's first module row below; the TOP half
  // is the terminal's default background (chrome). Using '▄' (LOWER HALF BLOCK)
  // with fg = QR bg and no bg override achieves the half-height effect.
  // Combined with the leftPad=1 on the horizontal axis, this keeps the
  // finder-pattern square margin consistent on both axes without stealing a
  // full row of vertical space.
  {
    const topBand = createEmptyLine(width);
    const endCol = Math.min(leftPad + cols + 1, width);
    for (let col = 0; col < endCol; col++) {
      topBand[col] = createStyledCell('▄', { fg: bg });
    }
    lines.push(topBand);
  }

  for (let termRow = 0; termRow < terminalRows; termRow++) {
    const matrixRowTop = termRow * 2;
    const matrixRowBot = termRow * 2 + 1;
    const topRow = modules[matrixRowTop];
    const botRow = matrixRowBot < rows ? modules[matrixRowBot] : null;

    const line = createEmptyLine(width);

    // Fill leading padding with bg
    for (let col = 0; col < leftPad && col < width; col++) {
      line[col] = createStyledCell(' ', { fg, bg });
    }

    // Render QR columns
    for (let col = 0; col < cols; col++) {
      const termCol = leftPad + col;
      if (termCol >= width) break;

      const topDark = topRow ? (topRow[col] ?? false) : false;
      const botDark = botRow ? (botRow[col] ?? false) : false;

      let char: string;
      let cellFg: string;
      let cellBg: string;

      if (topDark && botDark) {
        char = '█';
        cellFg = fg;
        cellBg = bg;
      } else if (topDark && !botDark) {
        char = '▀';
        cellFg = fg;
        cellBg = bg;
      } else if (!topDark && botDark) {
        char = '▄';
        cellFg = fg;
        cellBg = bg;
      } else {
        char = ' ';
        cellFg = fg;
        cellBg = bg;
      }

      // Some terminals may not render block chars at full width — guard
      const charWidth = getDisplayWidth(char);
      if (charWidth <= 0) {
        line[termCol] = createStyledCell(' ', { fg: cellFg, bg: cellBg });
      } else {
        line[termCol] = createStyledCell(char, { fg: cellFg, bg: cellBg });
      }
    }

    // Fill trailing with bg up to end of QR block
    for (let col = leftPad + cols; col < leftPad + cols + 1 && col < width; col++) {
      line[col] = createStyledCell(' ', { fg, bg });
    }

    lines.push(line);
  }

  return lines;
}

