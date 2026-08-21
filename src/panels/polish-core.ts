import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { createEmptyLine, createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeUiTones, registerThemeRefresh } from '../renderer/theme.ts';

// ---------------------------------------------------------------------------
// Panel palette + core line primitives.
//
// The leaf foundation of the panel formatting toolkit: both `polish.ts` and
// `polish-tables.ts` build on these. Kept dependency-free (only grid /
// terminal-width / ui-primitives) so it never participates in an import cycle.
// All symbols are re-exported from `polish.ts`, panels import from there.
// ---------------------------------------------------------------------------

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

// Built from the mode-resolved chrome tones (activeUiTones). Because 100+ call
// sites read this object by reference, mode changes rebuild it IN PLACE via the
// registered refresher below rather than re-resolving per call, see theme.ts's
// active-mode runtime note. This refresher is registered before any panel's
// extendPalette() runs (panels import polish → polish-core first), so on a mode
// flip the base is rebuilt before the extended palettes re-merge from it.
function buildPanelPalette(): Required<PanelPalette> {
  const t = activeUiTones();
  return {
    header: t.fg.primary,
    headerBg: t.bg.title,
    label: t.fg.muted,
    value: t.fg.primary,
    dim: t.fg.dim,
    info: t.state.info,
    good: t.state.good,
    warn: t.state.warn,
    bad: t.state.bad,
    empty: t.fg.empty,
    surfaceBg: t.bg.surface,
    sectionBg: t.bg.section,
    summaryBg: t.bg.summary,
    inputBg: t.bg.input,
    accent: t.fg.secondary,
    selectBg: t.bg.selected,
  };
}

export const DEFAULT_PANEL_PALETTE: Readonly<Required<PanelPalette>> = buildPanelPalette();
registerThemeRefresh(() => Object.assign(DEFAULT_PANEL_PALETTE as Required<PanelPalette>, buildPanelPalette()));

/**
 * Extend the base panel palette with domain-specific colors.
 *
 * Convention: raw hex colors may only live inside a palette constant declared
 * at the top of a panel file, not inline in render calls.
 *
 * @example
 * ```ts
 * const C = extendPalette(DEFAULT_PANEL_PALETTE, {
 *   decision: '#38bdf8',
 *   incident: '#ef4444',
 * });
 * ```
 */
export function extendPalette<T extends Record<string, string>>(
  base: typeof DEFAULT_PANEL_PALETTE,
  extras: T,
): typeof DEFAULT_PANEL_PALETTE & T {
  const merged = { ...base, ...extras } as typeof DEFAULT_PANEL_PALETTE & T;
  // Self-register an in-place rebuild so every extendPalette-derived panel
  // palette (cost/token/git/skills/diff/wrfc) tracks the active mode with zero
  // per-panel churn. Runs AFTER the base refresher (registered at module eval,
  // before any panel calls this), so `base` already carries the new-mode values.
  registerThemeRefresh(() => Object.assign(merged as Record<string, string>, base, extras));
  return merged;
}

export function buildPanelLine(
  width: number,
  segments: Array<StyledPanelSegment | [string, string, string?]>,
): Line {
  return buildStyledPanelLine(
    width,
    segments.map((seg) =>
      Array.isArray(seg) ? { text: seg[0], fg: seg[1], bg: seg[2] } : seg,
    ),
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
