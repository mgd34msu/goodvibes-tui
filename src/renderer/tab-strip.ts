import type { Line } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { buildStyledPanelLine, type StyledPanelSegment } from '../panels/polish.ts';

export interface TabStripItem {
  readonly label: string;
  readonly active?: boolean;
}

export interface TabStripStyle {
  readonly activeFg: string;
  readonly activeBg?: string;
  readonly activeBold?: boolean;
  readonly inactiveFg: string;
  readonly inactiveBg?: string;
  readonly separatorFg: string;
  readonly labelFg?: string;
  readonly labelBg?: string;
  readonly labelBold?: boolean;
  readonly overflowFg?: string;
  readonly trailingFg?: string;
}

export interface TabStripConfig {
  readonly width: number;
  readonly tabs: readonly TabStripItem[];
  readonly style: TabStripStyle;
  readonly prefixLabel?: string;
  readonly suffixLabel?: string;
  readonly overflowIndicator?: string;
}

function makeSegments(
  tabs: readonly TabStripItem[],
  style: TabStripStyle,
  maxWidth: number,
): { segments: StyledPanelSegment[]; hasOverflow: boolean } {
  const segments: StyledPanelSegment[] = [];
  let used = 0;
  let hasOverflow = false;
  for (const tab of tabs) {
    const separatorWidth = getDisplayWidth('|');
    const labelText = tab.active ? `[${tab.label}]` : tab.label;
    const labelWidth = getDisplayWidth(labelText);
    const entryWidth = separatorWidth + labelWidth + 1;
    if (used + entryWidth > maxWidth) {
      hasOverflow = true;
      break;
    }
    segments.push({ text: '|', fg: style.separatorFg });
    segments.push({
      text: `${labelText} `,
      fg: tab.active ? style.activeFg : style.inactiveFg,
      bg: tab.active ? style.activeBg : style.inactiveBg,
      bold: tab.active ? (style.activeBold ?? false) : false,
    });
    used += entryWidth;
  }

  if (segments.length > 0 && used + getDisplayWidth('|') <= maxWidth) {
    segments.push({ text: '|', fg: style.separatorFg });
  }
  return { segments, hasOverflow };
}

export function renderTabStrip(config: TabStripConfig): Line {
  const {
    width,
    tabs,
    style,
    prefixLabel,
    suffixLabel,
  overflowIndicator = '>',
  } = config;

  const reservedSuffixWidth = suffixLabel ? getDisplayWidth(suffixLabel) : 0;
  const reservedOverflowWidth = getDisplayWidth(overflowIndicator);
  const maxTabWidth = Math.max(
    0,
    width
      - (prefixLabel ? getDisplayWidth(prefixLabel) + 1 : 0)
      - (suffixLabel ? reservedSuffixWidth : 0)
      - reservedOverflowWidth,
  );

  const baseSegments: StyledPanelSegment[] = [];
  if (prefixLabel) {
    baseSegments.push({
      text: prefixLabel,
      fg: style.labelFg ?? style.inactiveFg,
      bg: style.labelBg,
      bold: style.labelBold ?? false,
    });
    baseSegments.push({ text: ' ', fg: style.separatorFg });
  }

  const { segments: tabSegments, hasOverflow } = makeSegments(tabs, style, maxTabWidth);
  const suffixSegments: StyledPanelSegment[] = [];
  if (hasOverflow) suffixSegments.push({ text: overflowIndicator, fg: style.overflowFg ?? style.separatorFg });
  if (suffixLabel) {
    suffixSegments.push({
      text: suffixLabel,
      fg: style.trailingFg ?? style.inactiveFg,
    });
  }

  return buildStyledPanelLine(width, [...baseSegments, ...tabSegments, ...suffixSegments]);
}
