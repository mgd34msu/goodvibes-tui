import type { Line } from '../types/grid.ts';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { GLYPHS, UI_TONES } from '../renderer/ui-primitives.ts';
// Build on the leaf primitives in ./polish-core.ts (palette + base line
// builders). polish-core has no back-edge to this file, so there is no cycle.
import { buildSelectablePanelLine, DEFAULT_PANEL_PALETTE } from './polish-core.ts';
import type { PanelPalette, StyledPanelSegment } from './polish-core.ts';

// ---------------------------------------------------------------------------
// Shared formatting primitives (the toolkit panels standardize on).
//
// All are display-width aware (via getDisplayWidth / truncateDisplay) so they
// stay aligned across emoji, CJK, and other wide characters — never hand-roll
// .slice()/.padEnd() truncation or alignment in panels.
// ---------------------------------------------------------------------------

export type ColumnAlign = 'left' | 'right' | 'center';

export interface ColumnSpec {
  /** Fixed display width of the column. */
  readonly width: number;
  /** Horizontal alignment within the column. Default 'left'. */
  readonly align?: ColumnAlign;
}

export interface AlignedCell {
  readonly text: string;
  readonly fg: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/** Truncate + pad `text` to exactly `width` display columns with alignment. */
function alignText(text: string, width: number, align: ColumnAlign): string {
  if (width <= 0) return '';
  const truncated = truncateDisplay(text, width);
  const pad = Math.max(0, width - getDisplayWidth(truncated));
  if (pad === 0) return truncated;
  if (align === 'right') return ' '.repeat(pad) + truncated;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + truncated + ' '.repeat(pad - left);
  }
  return truncated + ' '.repeat(pad);
}

/**
 * Build a multi-column row with display-width-aware alignment. Replaces manual
 * `.padEnd()`/`.padStart()` column math (which misaligns on wide chars).
 *
 * `cells` and `columns` are zip-aligned by index; extra cells are ignored.
 */
export function buildAlignedRow(
  width: number,
  cells: ReadonlyArray<AlignedCell>,
  columns: ReadonlyArray<ColumnSpec>,
  options: {
    readonly gap?: number;
    readonly selected?: boolean;
    readonly selectedBg?: string;
    readonly marker?: string;
    readonly fillBg?: string;
  } = {},
): Line {
  const gap = options.gap ?? 1;
  const segments: StyledPanelSegment[] = [];
  const count = Math.min(cells.length, columns.length);
  for (let i = 0; i < count; i++) {
    const col = columns[i]!;
    const cell = cells[i]!;
    if (i > 0 && gap > 0) segments.push({ text: ' '.repeat(gap), fg: cell.fg, bg: cell.bg });
    segments.push({
      text: alignText(cell.text, col.width, col.align ?? 'left'),
      fg: cell.fg,
      bg: cell.bg,
      bold: cell.bold,
      dim: cell.dim,
    });
  }
  return buildSelectablePanelLine(width, segments, {
    selected: options.selected,
    selectedBg: options.selectedBg,
    fillBg: options.fillBg,
    leadingMarker: options.marker,
  });
}

export type StatusBadgeKind =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'review';

interface BadgeSpec {
  readonly glyph: string;
  readonly fg: string;
  readonly label: string;
}

const STATUS_BADGES: Record<StatusBadgeKind, BadgeSpec> = {
  pending:   { glyph: GLYPHS.status.pending, fg: DEFAULT_PANEL_PALETTE.info, label: 'Pending' },
  running:   { glyph: GLYPHS.status.active,  fg: UI_TONES.state.active,      label: 'Running' },
  completed: { glyph: GLYPHS.status.success, fg: DEFAULT_PANEL_PALETTE.good, label: 'Completed' },
  failed:    { glyph: GLYPHS.status.failure, fg: DEFAULT_PANEL_PALETTE.bad,  label: 'Failed' },
  cancelled: { glyph: GLYPHS.status.skipped, fg: DEFAULT_PANEL_PALETTE.dim,  label: 'Cancelled' },
  blocked:   { glyph: GLYPHS.status.blocked, fg: UI_TONES.state.blocked,     label: 'Blocked' },
  review:    { glyph: GLYPHS.status.review,  fg: DEFAULT_PANEL_PALETTE.info, label: 'Review' },
};

/**
 * Canonical status badge (glyph + label) with a consistent color per lifecycle
 * state. Returns StyledPanelSegment[] — spread into a buildPanelLine call:
 *   buildPanelLine(width, [['  ', C.label], ...buildStatusBadge('running')])
 * Supersedes ad-hoc per-panel status→color maps.
 */
export function buildStatusBadge(
  kind: StatusBadgeKind,
  label?: string,
  opts?: { glyph?: string; bg?: string; count?: number },
): StyledPanelSegment[] {
  const spec = STATUS_BADGES[kind];
  const glyph = opts?.glyph ?? spec.glyph;
  const text = label ?? spec.label;
  const rendered = opts?.count !== undefined ? `${glyph} ${text} (${opts.count})` : `${glyph} ${text}`;
  return [{ text: rendered, fg: spec.fg, bg: opts?.bg }];
}

export interface TreeItemSpec {
  readonly depth: number;
  readonly label: string;
  readonly icon?: string;
  readonly expandable?: boolean;
  readonly expanded?: boolean;
  readonly labelColor?: string;
  /** Right-aligned metadata columns (e.g. size, mtime). */
  readonly metadata?: ReadonlyArray<{ text: string; fg: string }>;
}

/**
 * Build a hierarchical tree row: indentation + expand/collapse glyph + optional
 * icon + label, with right-aligned metadata. Replaces hand-rolled indentation
 * in file-explorer / symbol-outline / orchestration panels.
 */
export function buildTreeRow(
  width: number,
  item: TreeItemSpec,
  palette: PanelPalette,
  options: { selected?: boolean; selectedBg?: string; indentWidth?: number } = {},
): Line {
  const indent = ' '.repeat(Math.max(0, item.depth) * (options.indentWidth ?? 2));
  const toggle = item.expandable
    ? (item.expanded ? GLYPHS.navigation.expanded : GLYPHS.navigation.collapsed)
    : ' ';
  const iconPart = item.icon ? `${item.icon} ` : '';
  const prefix = `${indent}${toggle} ${iconPart}`;
  const prefixW = getDisplayWidth(prefix);

  const metadata = item.metadata ?? [];
  const metaText = metadata.map((m) => m.text).join(' ');
  const metaW = getDisplayWidth(metaText);
  const reserve = metaW > 0 ? metaW + 1 : 0;

  const labelBudget = Math.max(0, width - prefixW - reserve);
  const label = truncateDisplay(item.label, labelBudget);
  const usedW = prefixW + getDisplayWidth(label);

  const segments: StyledPanelSegment[] = [
    { text: prefix, fg: palette.dim },
    { text: label, fg: item.labelColor ?? palette.value },
  ];
  if (metaW > 0) {
    const spacer = Math.max(1, width - usedW - metaW);
    segments.push({ text: ' '.repeat(spacer), fg: palette.dim });
    metadata.forEach((m, i) => {
      if (i > 0) segments.push({ text: ' ', fg: palette.dim });
      segments.push({ text: m.text, fg: m.fg });
    });
  }
  return buildSelectablePanelLine(width, segments, {
    selected: options.selected,
    selectedBg: options.selectedBg ?? palette.selectBg,
  });
}

export interface TableColumn {
  readonly label: string;
  /** Fixed width; omit to auto-distribute remaining space. */
  readonly width?: number;
  readonly align?: ColumnAlign;
}

export interface TableCell {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: boolean;
}

export interface TableRow {
  readonly cells: ReadonlyArray<TableCell>;
  readonly selected?: boolean;
}

/** Resolve concrete per-column widths, auto-distributing any unsized columns. */
function resolveColumnWidths(width: number, columns: ReadonlyArray<TableColumn>, gap: number): number[] {
  const totalGap = gap * Math.max(0, columns.length - 1);
  const explicit = columns.reduce((s, c) => s + (c.width ?? 0), 0);
  const autoIdx = columns.map((c, i) => (c.width === undefined ? i : -1)).filter((i) => i >= 0);
  const autoBudget = Math.max(0, width - totalGap - explicit);
  const each = autoIdx.length > 0 ? Math.floor(autoBudget / autoIdx.length) : 0;
  const widths = columns.map((c) => c.width ?? each);
  if (autoIdx.length > 0) {
    const used = each * autoIdx.length;
    widths[autoIdx[autoIdx.length - 1]!] += autoBudget - used; // remainder to last auto col
  }
  return widths;
}

/**
 * Build a table: a header row plus aligned data rows. Replaces ad-hoc
 * row/column offset math in history/ledger/roster panels.
 */
export function buildTable(
  width: number,
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<TableRow>,
  palette: PanelPalette,
  options: { gap?: number; selectedBg?: string } = {},
): Line[] {
  const gap = options.gap ?? 1;
  const widths = resolveColumnWidths(width, columns, gap);
  const specs: ColumnSpec[] = columns.map((c, i) => ({ width: widths[i]!, align: c.align }));

  const header = buildAlignedRow(
    width,
    columns.map((c) => ({ text: c.label, fg: palette.label, bold: true })),
    specs,
    { gap },
  );

  const dataRows = rows.map((row) =>
    buildAlignedRow(
      width,
      columns.map((_, i) => {
        const cell = row.cells[i] ?? { text: '', fg: palette.value };
        return { text: cell.text, fg: cell.fg ?? palette.value, bg: cell.bg, bold: cell.bold };
      }),
      specs,
      { gap, selected: row.selected, selectedBg: options.selectedBg ?? palette.selectBg },
    ),
  );

  return [header, ...dataRows];
}
