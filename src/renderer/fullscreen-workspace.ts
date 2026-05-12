import type { Line } from '../types/grid.ts';
import { GLYPHS } from './ui-primitives.ts';
import {
  borderLine,
  clamp,
  contentLine,
  drawHorizontalRule,
  drawVerticalRule,
  fillRange,
  FULLSCREEN_PALETTE,
  makeLine,
  writeText,
} from './fullscreen-primitives.ts';

export {
  borderLine,
  clamp,
  contentLine,
  fillRange,
  makeLine,
  padDisplay,
  stableWindow,
  writeText,
} from './fullscreen-primitives.ts';
export { FULLSCREEN_PALETTE as WORKSPACE_PALETTE } from './fullscreen-primitives.ts';

const WORKSPACE_PALETTE = FULLSCREEN_PALETTE;

export interface WorkspaceRow {
  readonly text: string;
  readonly selected?: boolean;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly fg?: string;
  readonly bg?: string;
  readonly kind?: 'group' | 'item' | 'more' | 'empty';
}

export interface FullscreenWorkspaceRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly stateLabel?: string;
  readonly leftHeader: string;
  readonly mainHeader: string;
  readonly leftRows: readonly WorkspaceRow[];
  readonly contextRows: readonly WorkspaceRow[];
  readonly controlRows: readonly WorkspaceRow[];
  readonly footer: string;
  readonly leftWidth?: number;
  readonly contextRatio?: number;
  readonly minContextRows?: number;
}

export interface FullscreenWorkspaceMetrics {
  readonly safeWidth: number;
  readonly safeHeight: number;
  readonly leftWidth: number;
  readonly centerWidth: number;
  readonly bodyRows: number;
  readonly contextWidth: number;
  readonly contextRows: number;
  readonly controlRows: number;
}

export function drawVertical(line: Line, x: number, bg = ''): void {
  if (x <= 0 || x >= line.length - 1) return;
  drawVerticalRule(line, x, WORKSPACE_PALETTE.border, bg);
}

export function drawHorizontalRange(line: Line, startX: number, endX: number, bg = ''): void {
  drawHorizontalRule(line, Math.max(1, startX), Math.min(line.length - 2, endX), WORKSPACE_PALETTE.border, bg);
}

function leftWidthFor(width: number, explicit?: number): number {
  if (explicit !== undefined) return clamp(explicit, 14, Math.max(14, width - 24));
  return width < 80
    ? clamp(Math.round(width * 0.32), 14, Math.max(14, width - 24))
    : clamp(Math.round(width * 0.22), 24, 34);
}

export function getFullscreenWorkspaceMetrics(options: Pick<
  FullscreenWorkspaceRenderOptions,
  'width' | 'height' | 'leftWidth' | 'contextRatio' | 'minContextRows'
>): FullscreenWorkspaceMetrics {
  const safeWidth = Math.max(1, options.width);
  const safeHeight = Math.max(12, options.height);
  const leftWidth = leftWidthFor(safeWidth, options.leftWidth);
  const centerWidth = Math.max(20, safeWidth - leftWidth - 3);
  const bodyTop = 3;
  const footerY = safeHeight - 2;
  const bodyRows = Math.max(4, footerY - bodyTop);
  const contextWidth = Math.max(10, centerWidth - 2);
  const maxContextRows = Math.max(3, bodyRows - 4);
  const minContextRows = clamp(options.minContextRows ?? 10, 3, maxContextRows);
  const contextRows = clamp(
    Math.round(bodyRows * (options.contextRatio ?? 0.4)),
    Math.min(minContextRows, maxContextRows),
    maxContextRows,
  );
  const controlRows = Math.max(3, bodyRows - contextRows - 1);
  return { safeWidth, safeHeight, leftWidth, centerWidth, bodyRows, contextWidth, contextRows, controlRows };
}

function rowFg(row: WorkspaceRow, fallback: string): string {
  if (row.fg) return row.fg;
  if (row.kind === 'group') return WORKSPACE_PALETTE.subtitle;
  if (row.kind === 'more') return WORKSPACE_PALETTE.dim;
  return fallback;
}

export function renderFullscreenWorkspace(options: FullscreenWorkspaceRenderOptions): Line[] {
  const { safeWidth, safeHeight, leftWidth, centerWidth, bodyRows, contextWidth, contextRows } = getFullscreenWorkspaceMetrics(options);
  const leftStart = 1;
  const dividerX = leftWidth + 1;
  const centerStart = dividerX + 1;
  const centerEnd = safeWidth - 2;
  const bodyTop = 3;
  const separatorY = bodyTop + contextRows;
  const lines: Line[] = [];

  const top = borderLine(safeWidth, GLYPHS.frame.topLeft, GLYPHS.frame.horizontal, GLYPHS.frame.topRight);
  writeText(top, 2, safeWidth - 4, ` ${options.title} `, { fg: WORKSPACE_PALETTE.title, bold: true });
  if (options.stateLabel) {
    writeText(top, Math.max(2, safeWidth - options.stateLabel.length - 4), options.stateLabel.length, options.stateLabel, {
      fg: WORKSPACE_PALETTE.subtitle,
    });
  }
  lines.push(top);

  const header = contentLine(safeWidth, WORKSPACE_PALETTE.footerBg);
  drawVertical(header, dividerX, WORKSPACE_PALETTE.footerBg);
  writeText(header, leftStart + 1, leftWidth - 2, options.leftHeader, {
    fg: WORKSPACE_PALETTE.subtitle,
    bold: true,
    bg: WORKSPACE_PALETTE.footerBg,
  });
  writeText(header, centerStart + 1, centerWidth - 2, options.mainHeader, {
    fg: WORKSPACE_PALETTE.subtitle,
    bold: true,
    bg: WORKSPACE_PALETTE.footerBg,
  });
  lines.push(header);

  const headerSep = contentLine(safeWidth, '');
  drawVertical(headerSep, dividerX);
  drawHorizontalRange(headerSep, 1, safeWidth - 2);
  lines.push(headerSep);

  for (let row = 0; row < bodyRows; row += 1) {
    const y = bodyTop + row;
    const inContext = y < separatorY;
    const inSeparator = y === separatorY;
    const bg = inSeparator ? '' : inContext ? WORKSPACE_PALETTE.contextBg : WORKSPACE_PALETTE.controlsBg;
    const line = contentLine(safeWidth, bg);
    fillRange(line, 1, dividerX - 1, WORKSPACE_PALETTE.categoryBg);
    drawVertical(line, dividerX, bg);

    const leftRow = options.leftRows[row] ?? { text: '', kind: 'empty' as const };
    if (leftRow.selected) fillRange(line, leftStart, dividerX - 1, WORKSPACE_PALETTE.selectedBg);
    writeText(line, leftStart + 1, leftWidth - 3, leftRow.text, {
      fg: leftRow.selected ? WORKSPACE_PALETTE.text : rowFg(leftRow, WORKSPACE_PALETTE.muted),
      bg: leftRow.selected ? WORKSPACE_PALETTE.selectedBg : WORKSPACE_PALETTE.categoryBg,
      bold: leftRow.bold ?? (leftRow.selected || leftRow.kind === 'group'),
      dim: leftRow.dim,
    });

    if (inSeparator) {
      drawHorizontalRange(line, centerStart, centerEnd);
    } else if (inContext) {
      const contextRow = options.contextRows[row] ?? { text: '', kind: 'empty' as const };
      writeText(line, centerStart + 1, contextWidth, contextRow.text, {
        fg: rowFg(contextRow, WORKSPACE_PALETTE.text),
        bg,
        bold: contextRow.bold,
        dim: contextRow.dim ?? contextRow.text.length === 0,
      });
    } else {
      const controlRow = options.controlRows[row - contextRows - 1] ?? { text: '', kind: 'empty' as const };
      if (controlRow.selected) fillRange(line, centerStart, centerEnd, WORKSPACE_PALETTE.selectedBg);
      writeText(line, centerStart + 1, contextWidth, controlRow.text, {
        fg: controlRow.selected ? WORKSPACE_PALETTE.text : rowFg(controlRow, WORKSPACE_PALETTE.text),
        bg: controlRow.selected ? WORKSPACE_PALETTE.selectedBg : bg,
        bold: controlRow.bold ?? controlRow.selected,
        dim: controlRow.dim ?? controlRow.text.length === 0,
      });
    }

    lines.push(line);
  }

  const footer = contentLine(safeWidth, WORKSPACE_PALETTE.footerBg);
  writeText(footer, 2, safeWidth - 4, options.footer, { fg: WORKSPACE_PALETTE.muted, bg: WORKSPACE_PALETTE.footerBg });
  lines.push(footer);
  lines.push(borderLine(safeWidth, GLYPHS.frame.bottomLeft, GLYPHS.frame.horizontal, GLYPHS.frame.bottomRight));

  while (lines.length < safeHeight) lines.unshift(makeLine(safeWidth));
  return lines.slice(-safeHeight);
}
