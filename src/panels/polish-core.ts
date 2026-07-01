import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { UI_TONES } from '../renderer/ui-primitives.ts';

// ---------------------------------------------------------------------------
// Panel palette + core line primitives.
//
// The leaf foundation of the panel formatting toolkit: both `polish.ts` and
// `polish-tables.ts` build on these. Kept dependency-free (only grid /
// terminal-width / ui-primitives) so it never participates in an import cycle.
// All symbols are re-exported from `polish.ts` — panels import from there.
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
  return { ...base, ...extras };
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
