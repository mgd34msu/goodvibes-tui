import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { getOverlayMaxWidth } from './overlay-viewport.ts';

export interface OverlayBoxPalette {
  readonly borderFg: string;
  readonly titleFg: string;
  readonly bodyFg: string;
  readonly mutedFg: string;
  readonly selectedBg: string;
}

export const DEFAULT_OVERLAY_PALETTE: Readonly<OverlayBoxPalette> = {
  borderFg: '#00d7ff',
  titleFg: '#00ffff',
  bodyFg: '252',
  mutedFg: '240',
  selectedBg: '#103040',
} as const;

export interface OverlayBoxLayout {
  readonly margin: number;
  readonly width: number;
  readonly contentWidth: number;
  readonly innerWidth: number;
}

export interface OverlayTextStyle {
  fg: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export function createOverlayBoxLayout(
  terminalWidth: number,
  margin: number,
  maxWidth: number,
): OverlayBoxLayout {
  const resolvedMaxWidth = getOverlayMaxWidth(terminalWidth, margin, maxWidth);
  const width = Math.max(20, Math.min(terminalWidth - margin * 2, resolvedMaxWidth));
  const contentWidth = width - 2;
  const innerWidth = contentWidth - 2;
  return { margin, width, contentWidth, innerWidth };
}

export function putOverlayText(
  line: Line,
  startX: number,
  maxWidth: number,
  text: string,
  style: OverlayTextStyle,
): void {
  let x = startX;
  let used = 0;
  for (const ch of text) {
    const cellWidth = getDisplayWidth(ch);
    if (cellWidth <= 0) continue;
    if (used + cellWidth > maxWidth || x >= line.length) break;
    line[x] = createStyledCell(ch, {
      fg: style.fg,
      bg: style.bg ?? '',
      bold: style.bold ?? false,
      dim: style.dim ?? false,
    });
    if (cellWidth > 1 && x + 1 < line.length) {
      line[x + 1] = createStyledCell(' ', {
        fg: style.fg,
        bg: style.bg ?? '',
        bold: style.bold ?? false,
        dim: style.dim ?? false,
      });
    }
    x += cellWidth;
    used += cellWidth;
  }
}

export function createOverlayBorderLine(
  terminalWidth: number,
  layout: OverlayBoxLayout,
  left: string,
  fill: string,
  right: string,
  fg: string = DEFAULT_OVERLAY_PALETTE.borderFg,
): Line {
  const line = createEmptyLine(terminalWidth);
  const leftX = layout.margin;
  const rightX = layout.margin + layout.width - 1;
  line[leftX] = createStyledCell(left, { fg });
  for (let x = leftX + 1; x < rightX; x++) {
    line[x] = createStyledCell(fill, { fg });
  }
  line[rightX] = createStyledCell(right, { fg });
  return line;
}

export function createOverlayContentLine(
  terminalWidth: number,
  layout: OverlayBoxLayout,
  borderFg: string = DEFAULT_OVERLAY_PALETTE.borderFg,
  bg = '',
): Line {
  const line = createEmptyLine(terminalWidth);
  const leftX = layout.margin;
  const rightX = layout.margin + layout.width - 1;
  line[leftX] = createStyledCell('│', { fg: borderFg });
  for (let x = leftX + 1; x < rightX; x++) {
    line[x] = createStyledCell(' ', { bg });
  }
  line[rightX] = createStyledCell('│', { fg: borderFg });
  return line;
}
