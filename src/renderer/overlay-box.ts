import { createStyledCell, type Line } from '../types/grid.ts';
import { getOverlayMaxWidth } from './overlay-viewport.ts';
import { GLYPHS } from './ui-primitives.ts';
import { activeUiTones, registerThemeRefresh } from './theme.ts';
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

// Built from the mode-resolved chrome tones (activeUiTones) and rebuilt IN PLACE
// on a mode flip via the registered refresher (60+ call sites read it by
// reference — see theme.ts's active-mode runtime note).
function buildOverlayPalette(): OverlayBoxPalette {
  const t = activeUiTones();
  return {
    borderFg: t.fg.secondary,
    titleFg: t.fg.primary,
    bodyFg: t.fg.primary,
    mutedFg: t.fg.dim,
    selectedBg: t.bg.selected,
    titleBg: t.bg.title,
    sectionBg: t.bg.section,
    inputBg: t.bg.input,
    bodyBg: t.bg.surface,
  };
}

export const DEFAULT_OVERLAY_PALETTE: Readonly<OverlayBoxPalette> = buildOverlayPalette();
registerThemeRefresh(() => Object.assign(DEFAULT_OVERLAY_PALETTE as OverlayBoxPalette, buildOverlayPalette()));

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
  // The 20-column floor exists so overlays stay legible on ordinary narrow
  // terminals, but on a hostile-narrow terminal (terminalWidth smaller than
  // margin*2 + 20) that floor alone can push the box wider than the real
  // terminal, walking cells off the right edge of the line array. Clamp the
  // floored result back down to what actually fits before returning it.
  const availableWidth = Math.max(1, terminalWidth - margin * 2);
  const width = Math.min(availableWidth, Math.max(20, Math.min(availableWidth, resolvedMaxWidth)));
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
