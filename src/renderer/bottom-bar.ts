import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

export interface BottomBarStyle {
  readonly fg: string;
  readonly bg: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly underline?: boolean;
}

export function createBottomBarLine(width: number, style: BottomBarStyle): Line {
  const line = createEmptyLine(width);
  for (let col = 0; col < width; col++) {
    line[col] = createStyledCell(' ', {
      fg: style.fg,
      bg: style.bg,
      bold: style.bold ?? false,
      dim: style.dim ?? false,
      underline: style.underline ?? false,
    });
  }
  return line;
}

export function writeBottomBarText(
  line: Line,
  startX: number,
  maxWidth: number,
  text: string,
  style: BottomBarStyle,
): void {
  let x = startX;
  let used = 0;
  for (const ch of text) {
    const cellWidth = getDisplayWidth(ch);
    if (cellWidth <= 0) continue;
    if (used + cellWidth > maxWidth || x >= line.length) break;
    line[x] = createStyledCell(ch, {
      fg: style.fg,
      bg: style.bg,
      bold: style.bold ?? false,
      dim: style.dim ?? false,
      underline: style.underline ?? false,
    });
    if (cellWidth > 1 && x + 1 < line.length) {
      line[x + 1] = createStyledCell(' ', {
        fg: style.fg,
        bg: style.bg,
        bold: style.bold ?? false,
        dim: style.dim ?? false,
        underline: style.underline ?? false,
      });
    }
    x += cellWidth;
    used += cellWidth;
  }
}
