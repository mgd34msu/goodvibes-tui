import { createStyledCell, type Line } from '../types/grid.ts';
import { getOverlayMaxWidth } from './overlay-viewport.ts';
import { GLYPHS, UI_TONES } from './ui-primitives.ts';
import { fillWidth, makeLine, writeText } from './fullscreen-primitives.ts';

export interface OverlayBoxPalette {
  readonly borderFg: string;
  readonly titleFg: string;
  readonly bodyFg: string;
  readonly mutedFg: string;
  readonly selectedBg: string;
  readonly titleBg: string;
  readonly sectionBg: string;
  readonly inputBg: string;
  readonly bodyBg: string;
}

export const DEFAULT_OVERLAY_PALETTE: Readonly<OverlayBoxPalette> = {
  borderFg: UI_TONES.fg.secondary,
  titleFg: UI_TONES.fg.primary,
  bodyFg: UI_TONES.fg.primary,
  mutedFg: UI_TONES.fg.dim,
  selectedBg: UI_TONES.bg.selected,
  titleBg: UI_TONES.bg.title,
  sectionBg: UI_TONES.bg.section,
  inputBg: UI_TONES.bg.input,
  bodyBg: UI_TONES.bg.surface,
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
  writeText(line, startX, maxWidth, text, {
    fg: style.fg,
    bg: style.bg ?? '',
    bold: style.bold ?? false,
    dim: style.dim ?? false,
  });
}

export function createOverlayBorderLine(
  terminalWidth: number,
  layout: OverlayBoxLayout,
  left: string,
  fill: string,
  right: string,
  fg: string = DEFAULT_OVERLAY_PALETTE.borderFg,
): Line {
  const line = makeLine(terminalWidth);
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
  const line = makeLine(terminalWidth);
  const leftX = layout.margin;
  const rightX = layout.margin + layout.width - 1;
  line[leftX] = createStyledCell('│', { fg: borderFg });
  fillWidth(line, leftX + 1, rightX - leftX - 1, bg);
  line[rightX] = createStyledCell('│', { fg: borderFg });
  return line;
}

export function createOverlayFilledBorderLine(
  terminalWidth: number,
  layout: OverlayBoxLayout,
  left: string,
  fill: string,
  right: string,
  fg: string = DEFAULT_OVERLAY_PALETTE.borderFg,
  bg = '',
): Line {
  const line = makeLine(terminalWidth);
  const leftX = layout.margin;
  const rightX = layout.margin + layout.width - 1;
  line[leftX] = createStyledCell(left, { fg, bg });
  for (let x = leftX + 1; x < rightX; x++) {
    line[x] = createStyledCell(fill, { fg, bg });
  }
  line[rightX] = createStyledCell(right, { fg, bg });
  return line;
}

export function createOverlayFrameLine(
  terminalWidth: number,
  layout: OverlayBoxLayout,
  bg = DEFAULT_OVERLAY_PALETTE.bodyBg,
): Line {
  return createOverlayContentLine(terminalWidth, layout, DEFAULT_OVERLAY_PALETTE.borderFg, bg);
}

export const OVERLAY_GLYPHS = {
  topLeft: GLYPHS.frame.topLeft,
  topRight: GLYPHS.frame.topRight,
  bottomLeft: GLYPHS.frame.bottomLeft,
  bottomRight: GLYPHS.frame.bottomRight,
  teeLeft: GLYPHS.frame.teeLeft,
  teeRight: GLYPHS.frame.teeRight,
  horizontal: GLYPHS.frame.horizontal,
  selected: GLYPHS.navigation.selected,
  expanded: GLYPHS.navigation.expanded,
  cursor: GLYPHS.surface.cursor,
  moreAbove: GLYPHS.navigation.moreAbove,
  moreBelow: GLYPHS.navigation.moreBelow,
} as const;
