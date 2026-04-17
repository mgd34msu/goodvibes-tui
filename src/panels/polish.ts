import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { getSurfaceContentRows, getTrackedVisibleWindow, getVisibleWindow, type VisibleWindow } from '../renderer/surface-layout.ts';
import { GLYPHS, UI_TONES } from '../renderer/ui-primitives.ts';
import { type StatusState, STATE_GLYPHS } from '../renderer/status-glyphs.ts';

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
  readonly surfaceBg?: string;
  readonly sectionBg?: string;
  readonly summaryBg?: string;
  readonly inputBg?: string;
  readonly accent?: string;
  readonly selectBg?: string;
}

export const DEFAULT_PANEL_PALETTE: Readonly<Required<PanelPalette>> = {
  header: UI_TONES.fg.primary,
  headerBg: UI_TONES.bg.title,
  label: UI_TONES.fg.muted,
  value: UI_TONES.fg.primary,
  dim: UI_TONES.fg.dim,
  info: UI_TONES.state.info,
  good: UI_TONES.state.good,
  warn: UI_TONES.state.warn,
  bad: UI_TONES.state.bad,
  empty: '#334155',
  surfaceBg: UI_TONES.bg.surface,
  sectionBg: UI_TONES.bg.section,
  summaryBg: UI_TONES.bg.summary,
  inputBg: UI_TONES.bg.input,
  accent: UI_TONES.fg.secondary,
  selectBg: UI_TONES.bg.selected,
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
  options: { selected?: boolean; selectedBg?: string; fillFg?: string; fillBg?: string; leadingMarker?: string } = {},
): Line {
  const selected = options.selected ?? false;
  const selectedBg = selected ? (options.selectedBg ?? DEFAULT_PANEL_PALETTE.selectBg) : '';
  const fillBg = selectedBg || options.fillBg || '';
  const fillFg = options.fillFg ?? '';
  const cells = createEmptyLine(width);
  if (fillBg) {
    for (let col = 0; col < width; col++) {
      cells[col] = createStyledCell(' ', { bg: fillBg, fg: fillFg });
    }
  }

  let col = 0;
  if (selected && options.leadingMarker) {
    for (const ch of options.leadingMarker) {
      const charWidth = getDisplayWidth(ch);
      if (charWidth <= 0 || col + charWidth > width) break;
      cells[col] = createStyledCell(ch, { fg: DEFAULT_PANEL_PALETTE.info, bg: selectedBg, bold: true });
      if (charWidth > 1 && col + 1 < width) cells[col + 1] = createStyledCell(' ', { fg: DEFAULT_PANEL_PALETTE.info, bg: selectedBg, bold: true });
      col += charWidth;
    }
  }
  for (const segment of segments) {
    const fg = segment.fg;
    const bg = segment.bg ?? fillBg;
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
    cells[col++] = createStyledCell(' ', { bg: fillBg, fg: fillFg });
  }
  return cells;
}

export function buildStyledPanelLine(
  width: number,
  segments: ReadonlyArray<StyledPanelSegment>,
  options: { fillBg?: string; fillFg?: string } = {},
): Line {
  return buildSelectablePanelLine(width, segments, options);
}

export function buildGuidanceLine(
  width: number,
  command: string,
  summary: string,
  palette: PanelPalette,
): Line {
  return buildPanelLine(width, [
    [` ${GLYPHS.status.info} `, palette.info],
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
  const titleText = fitDisplayText(` ${title}`, width);
  return buildStyledPanelLine(width, [
    { text: titleText, fg: palette.header ?? palette.accent ?? palette.value, bg: palette.headerBg, bold: true },
  ], { fillBg: palette.headerBg });
}

export function buildBodyText(
  width: number,
  text: string,
  palette: PanelPalette,
  fg: string = palette.value,
): Line[] {
  const wrapped = wrapText(text, Math.max(10, width - 2));
  return wrapped.map((line) => buildStyledPanelLine(width, [{ text: ` ${line}`, fg, bg: palette.surfaceBg }], { fillBg: palette.surfaceBg }));
}

export function buildSectionHeader(
  width: number,
  title: string,
  palette: PanelPalette,
): Line {
  const prefix = `${GLYPHS.status.dualPane} ${title}`;
  const divider = GLYPHS.frame.horizontal.repeat(Math.max(0, width - getDisplayWidth(prefix) - 2));
  return buildStyledPanelLine(width, [
    { text: ' ', fg: palette.label, bg: palette.sectionBg },
    { text: prefix, fg: palette.label, bg: palette.sectionBg, bold: true },
    { text: ' ', fg: palette.dim, bg: palette.sectionBg },
    { text: divider, fg: palette.dim, bg: palette.sectionBg },
  ], { fillBg: palette.sectionBg });
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
  return buildStyledPanelLine(width, segments.map(([text, fg, bg]) => ({ text, fg, bg: bg ?? palette.summaryBg })), { fillBg: palette.summaryBg });
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

export function buildPanelListRow(
  width: number,
  segments: ReadonlyArray<StyledPanelSegment>,
  palette: PanelPalette,
  options: {
    readonly selected?: boolean;
    readonly selectedBg?: string;
    readonly marker?: string;
    readonly markerColor?: string;
    readonly fillBg?: string;
  } = {},
): Line {
  const selected = options.selected ?? false;
  const selectedBg = options.selectedBg ?? palette.selectBg;
  const fillBg = selected ? selectedBg : options.fillBg;
  const marker = selected ? `${options.marker ?? GLYPHS.navigation.selected} ` : '  ';
  const markerFg = selected ? (options.markerColor ?? palette.info) : palette.dim;
  return buildStyledPanelLine(width, [
    { text: marker, fg: markerFg, bg: fillBg, bold: selected },
    ...segments.map((segment) => ({
      ...segment,
      bg: segment.bg ?? fillBg,
    })),
  ], { fillBg });
}

export function buildSearchInputLine(
  width: number,
  label: string,
  value: string,
  palette: PanelPalette,
  options: { active?: boolean; bg?: string; emptyLabel?: string; valueColor?: string } = {},
): Line {
  const active = options.active ?? false;
  const normalizedValue = active && value.endsWith('_')
    ? `${value.slice(0, -1)}${GLYPHS.surface.cursor}`
    : value;
  const hasValue = normalizedValue.trim().length > 0;
  const content = hasValue ? normalizedValue : (options.emptyLabel ?? '(none)');
  const bg = options.bg ?? (active ? palette.inputBg : palette.sectionBg);
  const fg = active
    ? options.valueColor ?? palette.info
    : hasValue
      ? options.valueColor ?? palette.value
      : palette.dim;
  return buildStyledPanelLine(width, [
    { text: ' ', fg: palette.label, bg },
    { text: `${label}`, fg: palette.label, bg },
    { text: content, fg, bg, bold: active },
  ], { fillBg: bg });
}

// ---------------------------------------------------------------------------
// buildStatusPill — glyph + color status segment for use in buildPanelLine.
//
// Returns Array<[string, string, string?]> compatible with buildPanelLine so
// that callers can spread it inline:
//   buildPanelLine(width, [['  count ', C.label], ...buildStatusPill('bad', '3')])
//
// Mirrors buildStatusToken semantics (always glyph + color) but produces
// plain text+color tuples rather than Cell[] for direct buildPanelLine use.
//
// ---------------------------------------------------------------------------

/**
 * TODO(consolidation): buildStatusPill (tuple form) and buildStatusToken (Cell[]
 * form) are parallel APIs. Long-term, consider extending buildPanelLine to accept
 * Cell[] segments so buildStatusToken can become the single source of truth.
 * For now the pill variant exists to bridge tuple-based buildPanelLine consumers.
 */
export function buildStatusPill(
  state: StatusState,
  label: string,
  opts?: { glyph?: string; bg?: string; count?: number },
): Array<[string, string, string?]> {
  const glyph = opts?.glyph ?? STATE_GLYPHS[state];
  const color = state === 'good' ? DEFAULT_PANEL_PALETTE.good
    : state === 'warn' ? DEFAULT_PANEL_PALETTE.warn
    : state === 'bad'  ? DEFAULT_PANEL_PALETTE.bad
    : DEFAULT_PANEL_PALETTE.info;
  const bg = opts?.bg;
  const text = opts?.count !== undefined ? `${glyph} ${label} (${opts.count})` : `${glyph} ${label}`;
  return [
    [text, color, bg],
  ];
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
  const emptyChar = options.emptyChar ?? GLYPHS.meter.empty;
  const normalizedFilledChar = options.filledChar ?? GLYPHS.meter.filled;
  const barWidth = Math.max(1, total);
  const clampedFilled = Math.max(0, Math.min(barWidth, filled));
  const segments: StyledPanelSegment[] = [{ text: prefix, fg: colors.label ?? colors.filled }];
  if (clampedFilled > 0) {
    segments.push({ text: normalizedFilledChar.repeat(clampedFilled), fg: colors.filled });
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

export function buildSummaryBlock(
  width: number,
  title: string,
  rows: readonly Line[],
  palette: PanelPalette,
): Line[] {
  const lines: Line[] = [
    buildStyledPanelLine(width, [
      { text: ` ${GLYPHS.status.active} ${title}`, fg: palette.header ?? palette.value, bg: palette.summaryBg, bold: true },
    ], { fillBg: palette.summaryBg }),
  ];
  for (const row of rows) lines.push(row);
  return lines;
}

export function buildDetailBlock(
  width: number,
  title: string,
  rows: readonly Line[],
  palette: PanelPalette,
): Line[] {
  return [
    buildStyledPanelLine(width, [
      { text: ` ${GLYPHS.status.review} ${title}`, fg: palette.header ?? palette.value, bg: palette.sectionBg, bold: true },
    ], { fillBg: palette.sectionBg }),
    ...rows.map((row) => row.map((cell) => (
      cell.bg
        ? cell
        : createStyledCell(cell.char, {
            fg: cell.fg,
            bg: palette.surfaceBg,
            bold: cell.bold,
            dim: cell.dim,
            underline: cell.underline,
          })
    ))),
  ];
}

function fitDisplayText(text: string, width: number): string {
  let col = 0;
  let out = '';
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0 || col + w > width) break;
    out += ch;
    col += w;
  }
  return out;
}

export interface PanelWorkspaceSection {
  readonly title?: string;
  readonly lines: readonly Line[];
}

export interface PrimaryScrollablePanelSectionConfig {
  readonly title?: string;
  readonly fixedLines?: readonly Line[];
  readonly scrollableLines: readonly Line[];
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly guardRows?: number;
  readonly minRows?: number;
  readonly appendWindowSummary?: {
    readonly dimColor?: string;
    readonly formatter?: (window: VisibleWindow) => Line;
  };
}

export interface ScrollablePanelSectionConfig {
  readonly title?: string;
  readonly fixedLines?: readonly Line[];
  readonly scrollableLines: readonly Line[];
  readonly scrollOffset: number;
  readonly selectedIndex?: number;
  readonly guardRows?: number;
  readonly minRows?: number;
  readonly appendWindowSummary?: {
    readonly dimColor?: string;
    readonly formatter?: (window: VisibleWindow) => Line;
  };
}

export interface StackedScrollablePanelSectionConfig extends ScrollablePanelSectionConfig {
  readonly weight?: number;
}

export interface PanelWorkspaceConfig {
  readonly title: string;
  readonly intro?: string;
  readonly sections: readonly PanelWorkspaceSection[];
  readonly footerLines?: readonly Line[];
  readonly palette: PanelPalette;
}

function getPanelWorkspaceIntroRows(
  width: number,
  intro: string | undefined,
  palette: PanelPalette,
): number {
  return intro ? buildBodyText(width, intro, palette, palette.dim).length : 0;
}

export function getPanelWorkspaceContentBudget(
  width: number,
  height: number,
  config: Pick<PanelWorkspaceConfig, 'intro' | 'footerLines' | 'palette'>,
): number {
  const footerLines = [...(config.footerLines ?? [])];
  const chromeRows = 1 + getPanelWorkspaceIntroRows(width, config.intro, config.palette) + footerLines.length;
  return Math.max(
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
}

export function getPanelWorkspaceSectionRows(section: PanelWorkspaceSection): number {
  return (section.title ? 1 : 0) + section.lines.length;
}

export function getPanelScrollableSectionBudget(
  width: number,
  height: number,
  options: {
    readonly intro?: string;
    readonly footerLines?: readonly Line[];
    readonly palette: PanelPalette;
    readonly beforeSections?: readonly PanelWorkspaceSection[];
    readonly currentSectionTitle?: string;
    readonly currentSectionFixedRows?: number;
    readonly afterSections?: readonly PanelWorkspaceSection[];
    readonly minRows?: number;
  },
): number {
  const contentBudget = getPanelWorkspaceContentBudget(width, height, options);
  const beforeRows = (options.beforeSections ?? []).reduce((sum, section) => sum + getPanelWorkspaceSectionRows(section), 0);
  const afterRows = (options.afterSections ?? []).reduce((sum, section) => sum + getPanelWorkspaceSectionRows(section), 0);
  const currentHeaderRows = options.currentSectionTitle ? 1 : 0;
  const currentFixedRows = Math.max(0, options.currentSectionFixedRows ?? 0);
  return Math.max(options.minRows ?? 1, contentBudget - beforeRows - currentHeaderRows - currentFixedRows - afterRows);
}

export function resolvePrimaryScrollableSection(
  width: number,
  height: number,
  options: {
    readonly intro?: string;
    readonly footerLines?: readonly Line[];
    readonly palette: PanelPalette;
    readonly beforeSections?: readonly PanelWorkspaceSection[];
    readonly section: PrimaryScrollablePanelSectionConfig;
    readonly afterSections?: readonly PanelWorkspaceSection[];
  },
): {
  readonly section: PanelWorkspaceSection;
  readonly scrollOffset: number;
  readonly window: VisibleWindow;
} {
  return resolveScrollablePanelSection(width, height, {
    intro: options.intro,
    footerLines: options.footerLines,
    palette: options.palette,
    beforeSections: options.beforeSections,
    section: options.section,
    afterSections: options.afterSections,
  });
}

export function resolveScrollablePanelSection(
  width: number,
  height: number,
  options: {
    readonly intro?: string;
    readonly footerLines?: readonly Line[];
    readonly palette: PanelPalette;
    readonly beforeSections?: readonly PanelWorkspaceSection[];
    readonly section: ScrollablePanelSectionConfig;
    readonly afterSections?: readonly PanelWorkspaceSection[];
  },
): {
  readonly section: PanelWorkspaceSection;
  readonly scrollOffset: number;
  readonly window: VisibleWindow;
} {
  const fixedLines = [...(options.section.fixedLines ?? [])];
  const budget = getPanelScrollableSectionBudget(width, height, {
    intro: options.intro,
    footerLines: options.footerLines,
    palette: options.palette,
    beforeSections: options.beforeSections,
    currentSectionTitle: options.section.title,
    currentSectionFixedRows: fixedLines.length,
    afterSections: options.afterSections,
    minRows: options.section.minRows ?? 1,
  });
  const window = options.section.selectedIndex === undefined
    ? getVisibleWindow(
        options.section.scrollableLines.length,
        options.section.scrollOffset,
        budget,
      )
    : getTrackedVisibleWindow(
        options.section.scrollableLines.length,
        options.section.selectedIndex,
        budget,
        options.section.scrollOffset,
        options.section.guardRows ?? 1,
      );
  const lines = [
    ...fixedLines,
    ...options.section.scrollableLines.slice(window.start, window.end),
  ];
  if (options.section.appendWindowSummary && options.section.scrollableLines.length > window.count) {
    const summary = options.section.appendWindowSummary.formatter
      ? options.section.appendWindowSummary.formatter(window)
      : buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${window.total}`, options.section.appendWindowSummary.dimColor ?? options.palette.dim]]);
    lines.push(summary);
  }
  return {
    section: {
      title: options.section.title,
      lines,
    },
    scrollOffset: window.start,
    window,
  };
}

export function resolveStackedScrollableSections(
  width: number,
  height: number,
  options: {
    readonly intro?: string;
    readonly footerLines?: readonly Line[];
    readonly palette: PanelPalette;
    readonly beforeSections?: readonly PanelWorkspaceSection[];
    readonly sections: readonly StackedScrollablePanelSectionConfig[];
    readonly afterSections?: readonly PanelWorkspaceSection[];
  },
): ReadonlyArray<{
  readonly section: PanelWorkspaceSection;
  readonly scrollOffset: number;
  readonly window: VisibleWindow;
}> {
  if (options.sections.length === 0) return [];
  const contentBudget = getPanelWorkspaceContentBudget(width, height, options);
  const beforeRows = (options.beforeSections ?? []).reduce((sum, section) => sum + getPanelWorkspaceSectionRows(section), 0);
  const afterRows = (options.afterSections ?? []).reduce((sum, section) => sum + getPanelWorkspaceSectionRows(section), 0);
  const fixedChrome = options.sections.reduce((sum, section) => (
    sum
    + (section.title ? 1 : 0)
    + (section.fixedLines?.length ?? 0)
  ), 0);
  const allocatable = Math.max(1, contentBudget - beforeRows - afterRows - fixedChrome);
  const mins = options.sections.map((section) => Math.max(1, section.minRows ?? 1));
  const weights = options.sections.map((section) => Math.max(1, section.weight ?? 1));
  const totalMin = mins.reduce((sum, value) => sum + value, 0);
  const budgets = [...mins];
  let remaining = Math.max(0, allocatable - totalMin);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < budgets.length; i++) {
    if (remaining <= 0) break;
    const share = i === budgets.length - 1
      ? remaining
      : Math.floor((remaining * weights[i]!) / totalWeight);
    budgets[i]! += share;
    remaining -= share;
  }
  let cursor = 0;
  while (remaining > 0 && budgets.length > 0) {
    budgets[cursor % budgets.length]! += 1;
    remaining--;
    cursor++;
  }

  return options.sections.map((section, index) => {
    const fixedLines = [...(section.fixedLines ?? [])];
    const window = section.selectedIndex === undefined
      ? getVisibleWindow(section.scrollableLines.length, section.scrollOffset, budgets[index]!)
      : getTrackedVisibleWindow(
          section.scrollableLines.length,
          section.selectedIndex,
          budgets[index]!,
          section.scrollOffset,
          section.guardRows ?? 1,
        );
    const lines = [
      ...fixedLines,
      ...section.scrollableLines.slice(window.start, window.end),
    ];
    if (section.appendWindowSummary && section.scrollableLines.length > window.count) {
      const summary = section.appendWindowSummary.formatter
        ? section.appendWindowSummary.formatter(window)
        : buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${window.total}`, section.appendWindowSummary.dimColor ?? options.palette.dim]]);
      lines.push(summary);
    }
    return {
      section: {
        title: section.title,
        lines,
      },
      scrollOffset: window.start,
      window,
    };
  });
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
  const contentBudget = getPanelWorkspaceContentBudget(width, height, config);

  let consumed = 0;
  for (let sectionIndex = 0; sectionIndex < config.sections.length; sectionIndex++) {
    const section = config.sections[sectionIndex]!;
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
