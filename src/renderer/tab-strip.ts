import type { Line } from '@pellux/goodvibes-sdk/platform/types';
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

/** Absolute column range a rendered tab occupies, for click hit-testing. */
export interface TabHitRegion {
  /** Index into the original `tabs` array. */
  readonly index: number;
  /** First column (inclusive) the tab occupies on the line. */
  readonly startCol: number;
  /** Last column (exclusive) the tab occupies on the line. */
  readonly endCol: number;
}

export interface TabStripConfig {
  readonly width: number;
  readonly tabs: readonly TabStripItem[];
  readonly style: TabStripStyle;
  readonly prefixLabel?: string;
  readonly suffixLabel?: string;
  /** Right-side overflow glyph (more tabs after the window). Default '›'. */
  readonly overflowIndicator?: string;
  /** Left-side overflow glyph (more tabs before the window). Default '‹'. */
  readonly overflowIndicatorLeft?: string;
  /**
   * Optional callback invoked with the absolute column ranges of each rendered
   * tab. Used by the compositor to hit-test mouse clicks onto tabs. Additive,
   * the function still returns a `Line` so existing callers are unaffected.
   */
  readonly onLayout?: (regions: readonly TabHitRegion[]) => void;
}

const SEPARATOR = '│';

interface WindowResult {
  segments: StyledPanelSegment[];
  /** Per-tab column ranges relative to the start of the tab block. */
  regions: Array<{ index: number; startCol: number; endCol: number }>;
  overflowLeft: boolean;
  overflowRight: boolean;
}

/**
 * Build the visible tab segments, windowed so the ACTIVE tab is always shown.
 *
 * Tabs are laid out left-to-right, but when they don't all fit we keep a
 * contiguous window that contains the active tab and grow it outward (biased
 * toward following tabs) until the budget is exhausted. Left/right overflow is
 * reported so the caller can render `‹`/`›` indicators.
 */
function makeSegments(
  tabs: readonly TabStripItem[],
  style: TabStripStyle,
  maxWidth: number,
  indicatorWidth: number,
): WindowResult {
  const empty: WindowResult = { segments: [], regions: [], overflowLeft: false, overflowRight: false };
  if (tabs.length === 0 || maxWidth <= 0) return empty;

  const sepWidth = getDisplayWidth(SEPARATOR);
  // Per-tab entry width: leading separator + (bracketed if active) label + trailing space.
  const labelText = (tab: TabStripItem) => (tab.active ? `[${tab.label}]` : tab.label);
  const entryWidths = tabs.map((tab) => sepWidth + getDisplayWidth(labelText(tab)) + 1);

  const activeIndex = Math.max(0, tabs.findIndex((t) => t.active));
  const n = tabs.length;
  const closing = sepWidth; // trailing │ after the last visible tab
  const totalAll = entryWidths.reduce((a, b) => a + b, 0) + closing;

  let start = activeIndex;
  let end = activeIndex; // inclusive
  let used = entryWidths[activeIndex] + closing;

  if (totalAll <= maxWidth) {
    // Everything fits, show all tabs, no windowing.
    start = 0;
    end = n - 1;
  } else {
    // Need windowing. Reserve room for indicators on whichever side still has
    // hidden tabs; the reserve is recomputed each step so reaching an edge
    // frees its indicator column.
    const budget = maxWidth;
    let leftDone = start === 0;
    let rightDone = end === n - 1;
    let preferRight = true;

    const fits = (extra: number, nextStart: number, nextEnd: number) => {
      const leftRes = nextStart > 0 ? indicatorWidth : 0;
      const rightRes = nextEnd < n - 1 ? indicatorWidth : 0;
      return used + extra + leftRes + rightRes <= budget;
    };

    while (!leftDone || !rightDone) {
      const goRight = !rightDone && (preferRight || leftDone);
      if (goRight) {
        const ne = end + 1;
        if (fits(entryWidths[ne], start, ne)) {
          end = ne;
          used += entryWidths[ne];
          if (end === n - 1) rightDone = true;
          preferRight = false;
        } else {
          rightDone = true;
        }
      } else if (!leftDone) {
        const ns = start - 1;
        if (fits(entryWidths[ns], ns, end)) {
          start = ns;
          used += entryWidths[ns];
          if (start === 0) leftDone = true;
          preferRight = true;
        } else {
          leftDone = true;
        }
      } else {
        break;
      }
    }
  }

  const segments: StyledPanelSegment[] = [];
  const regions: Array<{ index: number; startCol: number; endCol: number }> = [];
  let col = 0;
  for (let i = start; i <= end; i++) {
    const tab = tabs[i];
    const text = labelText(tab);
    const entryStart = col;
    segments.push({ text: SEPARATOR, fg: style.separatorFg });
    segments.push({
      text: `${text} `,
      fg: tab.active ? style.activeFg : style.inactiveFg,
      bg: tab.active ? style.activeBg : style.inactiveBg,
      bold: tab.active ? (style.activeBold ?? false) : false,
    });
    col += entryWidths[i];
    regions.push({ index: i, startCol: entryStart, endCol: col });
  }
  // Closing separator.
  segments.push({ text: SEPARATOR, fg: style.separatorFg });

  return {
    segments,
    regions,
    overflowLeft: start > 0,
    overflowRight: end < n - 1,
  };
}

export function renderTabStrip(config: TabStripConfig): Line {
  const {
    width,
    tabs,
    style,
    prefixLabel,
    suffixLabel,
    overflowIndicator = '›',
    overflowIndicatorLeft = '‹',
    onLayout,
  } = config;

  const prefixWidth = prefixLabel ? getDisplayWidth(prefixLabel) + 1 : 0;
  const reservedSuffixWidth = suffixLabel ? getDisplayWidth(suffixLabel) : 0;
  const indicatorWidth = Math.max(
    getDisplayWidth(overflowIndicator),
    getDisplayWidth(overflowIndicatorLeft),
  );
  const maxTabWidth = Math.max(0, width - prefixWidth - reservedSuffixWidth);

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

  const { segments: tabSegments, regions, overflowLeft, overflowRight } =
    makeSegments(tabs, style, maxTabWidth, indicatorWidth);

  const leftSegments: StyledPanelSegment[] = [];
  if (overflowLeft) {
    leftSegments.push({ text: overflowIndicatorLeft, fg: style.overflowFg ?? style.separatorFg });
  }

  const suffixSegments: StyledPanelSegment[] = [];
  if (overflowRight) {
    suffixSegments.push({ text: overflowIndicator, fg: style.overflowFg ?? style.separatorFg });
  }
  if (suffixLabel) {
    suffixSegments.push({ text: suffixLabel, fg: style.trailingFg ?? style.inactiveFg });
  }

  // Report absolute hit regions: prefix + optional left indicator, then tabs.
  if (onLayout) {
    const offset = prefixWidth + (overflowLeft ? getDisplayWidth(overflowIndicatorLeft) : 0);
    onLayout(regions.map((r) => ({ index: r.index, startCol: offset + r.startCol, endCol: offset + r.endCol })));
  }

  return buildStyledPanelLine(width, [...baseSegments, ...leftSegments, ...tabSegments, ...suffixSegments]);
}
