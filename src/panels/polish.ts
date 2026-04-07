import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { getSurfaceContentRows } from '../renderer/surface-layout.ts';

export interface PanelPalette {
  readonly label: string;
  readonly value: string;
  readonly dim: string;
  readonly info: string;
  readonly good?: string;
  readonly warn?: string;
  readonly bad?: string;
  readonly empty: string;
  readonly header?: string;
  readonly headerBg?: string;
  readonly accent?: string;
  readonly selectBg?: string;
}

export const DEFAULT_PANEL_PALETTE: Readonly<Required<PanelPalette>> = {
  header: '#e2e8f0',
  headerBg: '#0f172a',
  label: '#94a3b8',
  value: '#e2e8f0',
  dim: '#475569',
  info: '#38bdf8',
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  empty: '#334155',
  accent: '#cbd5e1',
  selectBg: '#111827',
} as const;

export function buildPanelLine(
  width: number,
  segments: Array<[string, string, string?]>,
): Line {
  return buildStyledPanelLine(
    width,
    segments.map(([text, fg, bg]) => ({ text, fg, bg })),
  );
}

export interface StyledPanelSegment {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

export function buildSelectablePanelLine(
  width: number,
  segments: ReadonlyArray<StyledPanelSegment>,
  options: { selected?: boolean; selectedBg?: string; fillFg?: string } = {},
): Line {
  const selected = options.selected ?? false;
  const selectedBg = selected ? (options.selectedBg ?? DEFAULT_PANEL_PALETTE.selectBg) : '';
  const fillFg = options.fillFg ?? '';
  const cells = createEmptyLine(width);
  if (selectedBg) {
    for (let col = 0; col < width; col++) {
      cells[col] = createStyledCell(' ', { bg: selectedBg, fg: fillFg });
    }
  }

  let col = 0;
  for (const segment of segments) {
    const fg = segment.fg;
    const bg = segment.bg ?? selectedBg;
    for (const ch of segment.text) {
      const charWidth = getDisplayWidth(ch);
      if (charWidth <= 0) continue;
      if (col + charWidth > width) return cells;
      cells[col] = createStyledCell(ch, {
        fg,
        bg,
        bold: segment.bold ?? false,
        dim: segment.dim ?? false,
      });
      if (charWidth > 1 && col + 1 < width) {
        cells[col + 1] = createStyledCell(' ', {
          fg,
          bg,
          bold: segment.bold ?? false,
          dim: segment.dim ?? false,
        });
      }
      col += charWidth;
    }
  }

  while (col < width) {
    cells[col++] = createStyledCell(' ', { bg: selectedBg, fg: fillFg });
  }
  return cells;
}

export function buildStyledPanelLine(
  width: number,
  segments: ReadonlyArray<StyledPanelSegment>,
): Line {
  return buildSelectablePanelLine(width, segments);
}

export function buildGuidanceLine(
  width: number,
  command: string,
  summary: string,
  palette: PanelPalette,
): Line {
  return buildPanelLine(width, [
    ['  ', palette.label],
    [command, palette.info],
    ['  - ', palette.dim],
    [summary, palette.dim],
  ]);
}

export function buildPanelTitle(
  width: number,
  title: string,
  palette: PanelPalette,
): Line {
  return buildPanelLine(width, [[` ${title}`, palette.header ?? palette.accent ?? palette.value, palette.headerBg]]);
}

export function buildBodyText(
  width: number,
  text: string,
  palette: PanelPalette,
  fg: string = palette.value,
): Line[] {
  const wrapped = wrapText(text, Math.max(10, width - 2));
  return wrapped.map((line) => buildPanelLine(width, [[` ${line}`, fg]]));
}

export function buildSectionHeader(
  width: number,
  title: string,
  palette: PanelPalette,
): Line {
  const divider = '-'.repeat(Math.max(0, width - getDisplayWidth(title) - 3));
  return buildPanelLine(width, [
    [' ', palette.label],
    [title, palette.label],
    [' ', palette.dim],
    [divider, palette.dim],
  ]);
}

export function buildKeyValueLine(
  width: number,
  entries: ReadonlyArray<{ label: string; value: string; valueColor?: string }>,
  palette: PanelPalette,
): Line {
  const segments: Array<[string, string, string?]> = [];
  for (const entry of entries) {
    segments.push([' ', palette.label]);
    segments.push([`${entry.label} `, palette.label]);
    segments.push([entry.value, entry.valueColor ?? palette.value]);
    segments.push(['  ', palette.dim]);
  }
  return buildPanelLine(width, segments);
}

export function buildShortcutLine(
  width: number,
  keys: string,
  summary: string,
  palette: PanelPalette,
): Line {
  return buildPanelLine(width, [
    ['  ', palette.label],
    [keys, palette.info],
    ['  ', palette.dim],
    [summary, palette.dim],
  ]);
}

export function buildSearchInputLine(
  width: number,
  label: string,
  value: string,
  palette: PanelPalette,
  options: { active?: boolean; bg?: string; emptyLabel?: string; valueColor?: string } = {},
): Line {
  const active = options.active ?? false;
  const hasValue = value.trim().length > 0;
  const content = hasValue ? value : (options.emptyLabel ?? '(none)');
  const fg = active
    ? options.valueColor ?? palette.info
    : hasValue
      ? options.valueColor ?? palette.value
      : palette.dim;
  return buildPanelLine(width, [
    [' ', palette.label, options.bg],
    [label, palette.label, options.bg],
    [content, fg, options.bg],
  ]);
}

export function buildStatPill(
  label: string,
  value: string,
  labelColor: string,
  valueColor: string,
  bg = '',
): Array<[string, string, string?]> {
  return [
    [' ', labelColor, bg],
    [label, labelColor, bg],
    [' ', labelColor, bg],
    [value, valueColor, bg],
    ['  ', labelColor, bg],
  ];
}

export function buildMeterLine(
  width: number,
  filled: number,
  total: number,
  colors: { filled: string; empty: string; label?: string },
  options: { prefix?: string; suffix?: string; filledChar?: string; emptyChar?: string } = {},
): Line {
  const prefix = options.prefix ?? ' ';
  const suffix = options.suffix ?? ' ';
  const filledChar = options.filledChar ?? '#';
  const emptyChar = options.emptyChar ?? '.';
  const barWidth = Math.max(1, total);
  const clampedFilled = Math.max(0, Math.min(barWidth, filled));
  const segments: StyledPanelSegment[] = [{ text: prefix, fg: colors.label ?? colors.filled }];
  if (clampedFilled > 0) {
    segments.push({ text: filledChar.repeat(clampedFilled), fg: colors.filled });
  }
  if (clampedFilled < barWidth) {
    segments.push({ text: emptyChar.repeat(barWidth - clampedFilled), fg: colors.empty });
  }
  segments.push({ text: suffix, fg: colors.label ?? colors.filled });
  return buildStyledPanelLine(width, segments);
}

export function buildEmptyState(
  width: number,
  title: string,
  body: string,
  actions: ReadonlyArray<{ command: string; summary: string }>,
  palette: PanelPalette,
): Line[] {
  const lines: Line[] = [];
  lines.push(buildPanelLine(width, [[` ${title}`, palette.empty]]));
  lines.push(...buildBodyText(width, body, palette, palette.dim));
  if (actions.length > 0) {
    lines.push(buildPanelLine(width, [[' Suggested next steps', palette.label]]));
    for (const action of actions) {
      lines.push(buildGuidanceLine(width, action.command, action.summary, palette));
    }
  }
  return lines;
}

export interface PanelWorkspaceSection {
  readonly title?: string;
  readonly lines: readonly Line[];
}

export interface PanelWorkspaceConfig {
  readonly title: string;
  readonly intro?: string;
  readonly sections: readonly PanelWorkspaceSection[];
  readonly footerLines?: readonly Line[];
  readonly palette: PanelPalette;
}

export function buildPanelWorkspace(
  width: number,
  height: number,
  config: PanelWorkspaceConfig,
): Line[] {
  const lines: Line[] = [];
  lines.push(buildPanelTitle(width, config.title, config.palette));
  if (config.intro) {
    lines.push(...buildBodyText(width, config.intro, config.palette, config.palette.dim));
  }
  const footerLines = [...(config.footerLines ?? [])];
  const chromeRows = 1 + (config.intro ? buildBodyText(width, config.intro, config.palette, config.palette.dim).length : 0) + footerLines.length;
  const contentBudget = Math.max(
    1,
    getSurfaceContentRows({
      viewportHeight: height,
      chromeRows,
      minContentRows: 4,
      maxContentRows: Math.max(4, height - chromeRows),
      minTotalRows: 8,
      maxTotalRows: Math.max(8, height),
      targetRatio: 1,
    }),
  );

  let consumed = 0;
  for (const section of config.sections) {
    if (consumed >= contentBudget) break;
    if (section.title) {
      if (consumed >= contentBudget) break;
      lines.push(buildSectionHeader(width, section.title, config.palette));
      consumed++;
    }
    for (const line of section.lines) {
      if (consumed >= contentBudget) break;
      lines.push(line);
      consumed++;
    }
  }

  const contentAndChromeTarget = Math.max(0, height - footerLines.length);
  while (lines.length < contentAndChromeTarget) lines.push(createEmptyLine(width));
  lines.push(...footerLines);
  while (lines.length < height) lines.push(createEmptyLine(width));
  return lines.slice(0, height);
}
