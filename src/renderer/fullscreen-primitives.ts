import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { GLYPHS } from './ui-primitives.ts';
import { resolveUiTones } from './theme.ts';

// FULLSCREEN_PALETTE is built from the mode-resolved chrome tones
// (resolveUiTones) rather than the static UI_TONES constant — WO-001 single
// read path. Mode is fixed to 'dark' until the terminal-bg-probe lands.
const TONES = resolveUiTones('dark');

export const FULLSCREEN_PALETTE = {
  border: TONES.border,
  title: TONES.accent.browser,
  subtitle: TONES.accent.conversation,
  text: TONES.fg.primary,
  muted: TONES.fg.muted,
  dim: TONES.border,
  selectedBg: TONES.bg.selected,
  categoryBg: TONES.bg.section,
  contextBg: TONES.bg.surface,
  controlsBg: TONES.bg.base,
  footerBg: TONES.bg.footer,
  good: TONES.state.good,
  warn: TONES.state.warn,
  bad: TONES.state.bad,
  info: TONES.state.info,
} as const;

export type FullscreenTextStyle = Partial<Omit<Line[number], 'char'>>;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function fillRange(line: Line, startX: number, endX: number, bg: string): void {
  for (let x = Math.max(0, startX); x <= Math.min(line.length - 1, endX); x += 1) {
    const cell = line[x] ?? createStyledCell(' ');
    line[x] = createStyledCell(cell.char, {
      fg: cell.fg,
      bg,
      bold: cell.bold,
      dim: cell.dim,
      underline: cell.underline,
      italic: cell.italic,
      strikethrough: cell.strikethrough,
      link: cell.link,
    });
  }
}

export function fillWidth(line: Line, startX: number, width: number, bg: string): void {
  if (width <= 0) return;
  fillRange(line, startX, startX + width - 1, bg);
}

export function writeText(
  line: Line,
  startX: number,
  maxWidth: number,
  text: string,
  style: FullscreenTextStyle = {},
): void {
  let x = startX;
  let used = 0;
  for (const ch of text) {
    const width = getDisplayWidth(ch);
    if (width <= 0) continue;
    if (used + width > maxWidth || x >= line.length) break;
    line[x] = createStyledCell(ch, style);
    if (width > 1 && x + 1 < line.length) line[x + 1] = createStyledCell(' ', style);
    x += width;
    used += width;
  }
}

export function makeLine(width: number, bg = ''): Line {
  const line = createEmptyLine(width);
  if (bg) fillRange(line, 0, width - 1, bg);
  return line;
}

export function borderLine(width: number, left: string, fill: string, right: string, fg: string = FULLSCREEN_PALETTE.border): Line {
  const line = makeLine(width);
  if (width <= 0) return line;
  line[0] = createStyledCell(left, { fg });
  for (let x = 1; x < width - 1; x += 1) line[x] = createStyledCell(fill, { fg });
  if (width > 1) line[width - 1] = createStyledCell(right, { fg });
  return line;
}

export function contentLine(width: number, bg: string, borderFg: string = FULLSCREEN_PALETTE.border): Line {
  const line = makeLine(width, bg);
  if (width > 0) line[0] = createStyledCell(GLYPHS.frame.vertical, { fg: borderFg });
  if (width > 1) line[width - 1] = createStyledCell(GLYPHS.frame.vertical, { fg: borderFg });
  return line;
}

export function drawVerticalRule(line: Line, x: number, fg: string = FULLSCREEN_PALETTE.border, bg = ''): void {
  if (x < 0 || x >= line.length) return;
  line[x] = createStyledCell(GLYPHS.frame.vertical, { fg, bg });
}

export function drawHorizontalRule(line: Line, startX: number, endX: number, fg: string = FULLSCREEN_PALETTE.border, bg = ''): void {
  for (let x = Math.max(0, startX); x <= Math.min(line.length - 1, endX); x += 1) {
    line[x] = createStyledCell(GLYPHS.frame.horizontal, { fg, bg });
  }
}

export function clipDisplay(text: string, width: number): string {
  if (width <= 0) return '';
  let used = 0;
  let output = '';
  for (const ch of text) {
    const chWidth = getDisplayWidth(ch);
    if (chWidth <= 0) continue;
    if (used + chWidth > width) break;
    output += ch;
    used += chWidth;
  }
  return output;
}

export function padDisplay(text: string, width: number): string {
  const clipped = clipDisplay(text, width);
  return `${clipped}${' '.repeat(Math.max(0, width - getDisplayWidth(clipped)))}`;
}

export function stableWindow(total: number, selectedIndex: number, visibleCount: number): { start: number; end: number } {
  if (total <= 0 || visibleCount <= 0) return { start: 0, end: 0 };
  if (total <= visibleCount) return { start: 0, end: total };
  const selected = clamp(selectedIndex, 0, total - 1);
  const half = Math.floor(visibleCount / 2);
  const start = clamp(selected - half, 0, total - visibleCount);
  return { start, end: start + visibleCount };
}
