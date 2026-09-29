/**
 * renderConfigModal, the single render path for every ConfigModalSurface
 * (hooks, plugins, marketplace, skills, security, policy, knowledge, memory,
 * work plan, keybindings, pairing, planning, local auth, services, providers,
 * remote, sandbox, settings sync, devices, subscription, provider health).
 *
 * Drawn with the modal surface kit: soft caps, ✦ title with the esc keycap,
 * tabs (the active one carries the gradient), the always-live search row,
 * the surface's posture lines, kit rows (group headers where the surface has
 * sections, the selected row as the gradient), then status and notes, and the
 * keycap hint row. Reads the host's frozen-structure-plus-live-values render
 * model, so live ticks repaint values without moving rows.
 */

import { activeTokens } from './theme.ts';
import {
  beginModal,
  clipText,
  finishModal,
  modalGeometry,
  searchRow,
  scrollCountText,
  MODAL_PAD_X,
  type KitHint,
  type ModalFrame,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawRow, measureRow, type KitRow } from './surface-kit-list.ts';
import {
  drawTabRows,
  drawTextBlock,
  kitHintsFromStrings,
  tabRowCount,
  textBlockHeight,
  type TextLine,
} from './surface-kit-extra.ts';
import type { ConfigModal, ConfigModalRenderModel, ConfigModalRenderRow } from '../input/config-modal.ts';

function kitRowFor(row: ConfigModalRenderRow): KitRow {
  const label = row.label.replace(/\n/g, ' ');
  if (row.header) return { header: label };
  return {
    label,
    selected: row.selected,
    labelFg: row.style?.fg,
    bold: row.style?.bold === true,
    muted: row.stale,
  };
}

interface Layout {
  readonly hints: KitHint[];
  readonly topLines: TextLine[];
  readonly bottomLines: TextLine[];
}

function layoutFor(model: ConfigModalRenderModel): Layout {
  const t = activeTokens();
  const base: KitHint[] = [['↑↓', 'move']];
  if (model.tabs.length > 1) base.push(['←→', 'tab']);
  const { hints, notes } = kitHintsFromStrings(model.hints, base);
  const topLines: TextLine[] = [];
  if (model.degraded) topLines.push({ text: `⚠ ${model.degraded}`, style: { fg: t.warning, bold: true } });
  for (const line of model.header) topLines.push({ text: line, style: { fg: t.textMuted } });
  const bottomLines: TextLine[] = notes.map((text) => ({ text, style: { fg: t.textFaint } }));
  if (model.status) bottomLines.push({ text: model.status, style: { fg: model.confirmPending ? t.warning : t.accent, bold: model.confirmPending } });
  return { hints, topLines, bottomLines };
}

/**
 * Render the open config modal as a SurfaceLayer in screen coordinates.
 * Also tells the host how many list rows fit (setViewportRows) so its
 * row windowing matches what is drawn.
 */
export function renderConfigModal(modal: ConfigModal, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const geometry = modalGeometry(screenWidth, screenHeight);
  const textWidth = Math.max(1, geometry.w - 2 * MODAL_PAD_X);

  // First pass: header, status and hints decide how many rows the list gets.
  const first = modal.getRenderModel(textWidth);
  const firstLayout = layoutFor(first);
  const f0 = beginModal(screenWidth, screenHeight, { title: first.title || 'Settings', hints: firstLayout.hints });
  const firstCompact = compactionFor(first, firstLayout, f0);
  modal.setViewportRows(Math.max(3, listCapacity(first, firstLayout, f0, firstCompact)));

  const model = modal.getRenderModel(textWidth);
  const layout = layoutFor(model);
  const f = beginModal(screenWidth, screenHeight, { title: model.title || 'Settings', hints: layout.hints });
  const compact = compactionFor(model, layout, f);
  const { canvas, l, r } = f;
  const gap = compact.tight ? 0 : 1;

  let y = f.top;
  if (model.tabs.length > 1) {
    const active = Math.max(0, model.tabs.findIndex((tab) => tab.active));
    y += drawTabRows(canvas, l, y, model.tabs.map((tab) => tab.label), active, r) + gap;
  }
  const activeTab = model.tabs.find((tab) => tab.active);
  const placeholder = `Filter ${(activeTab?.label ?? 'rows').toLowerCase()}`;
  const count = model.search.total === 0
    ? ''
    : model.search.query.length > 0
      ? `${model.search.matched} of ${model.search.total}`
      : `${model.search.total} ${model.search.total === 1 ? 'item' : 'items'}`;
  searchRow(f, y, model.search.query, placeholder, count || undefined);
  y += 1 + gap;

  if (layout.topLines.length > 0 && !compact.dropTop) {
    y = drawTextBlock(canvas, l, y, r - l + 1, layout.topLines, f.bottom) + 1;
  }

  const bottomRows = bottomRowsFor(layout, r - l + 1);
  const listBottom = f.bottom - bottomRows;
  if (bottomRows > 0) drawTextBlock(canvas, l, listBottom + 2, r - l + 1, layout.bottomLines, f.bottom);

  let cutLines = 0;
  if (model.rows.length === 0) {
    drawTextBlock(canvas, l, y, r - l + 1, [{ text: model.emptyText ?? 'Nothing to show.', style: { fg: t.textMuted } }], listBottom);
  } else {
    cutLines = drawRows(model, canvas, y, listBottom, l, r);
  }

  const above = model.scroll.offset;
  const below = Math.max(0, model.scroll.total - model.scroll.offset - model.rows.length);
  // A single row taller than the list is cut at its bottom; say so honestly.
  const cut = cutLines > 0 ? `${cutLines} more ${cutLines === 1 ? 'line' : 'lines'} ↓` : '';
  f.hintRight = [scrollCountText(above, below), cut].filter(Boolean).join(' · ');
  return finishModal(f);
}

/** How the body gives way on short screens: posture lines go first, then the blank rows under tabs and search. */
interface Compaction {
  readonly dropTop: boolean;
  readonly tight: boolean;
}

const MIN_LIST_ROWS = 3;

function compactionFor(model: ConfigModalRenderModel, layout: Layout, f: ModalFrame): Compaction {
  const steps: Compaction[] = [
    { dropTop: false, tight: false },
    { dropTop: true, tight: false },
    { dropTop: true, tight: true },
  ];
  for (const step of steps) {
    if (listCapacity(model, layout, f, step) >= MIN_LIST_ROWS) return step;
  }
  return steps[steps.length - 1]!;
}

function listCapacity(model: ConfigModalRenderModel, layout: Layout, f: ModalFrame, compact: Compaction): number {
  const width = f.r - f.l + 1;
  const gap = compact.tight ? 0 : 1;
  let y = f.top;
  if (model.tabs.length > 1) y += tabRowCount(model.tabs.map((tab) => tab.label), f.l, f.r) + gap;
  y += 1 + gap;
  if (layout.topLines.length > 0 && !compact.dropTop) y += textBlockHeight(layout.topLines, width) + 1;
  return f.bottom - y + 1 - bottomRowsFor(layout, width);
}

/** Rows kept under the list for notes and status (plus the blank row above them). */
function bottomRowsFor(layout: Layout, width: number): number {
  return layout.bottomLines.length > 0 ? textBlockHeight(layout.bottomLines, width) + 1 : 0;
}

function drawRows(
  model: ConfigModalRenderModel,
  canvas: ReturnType<typeof beginModal>['canvas'],
  top: number,
  bottom: number,
  l: number,
  r: number,
): number {
  const rows = model.rows.map(kitRowFor);
  let cut = 0;
  const capacity = Math.max(1, bottom - top + 1);
  const needed = rows.reduce((n, row, k) => n + measureRow(row, l, r) + (k > 0 && row.header !== undefined ? 1 : 0), 0);
  const gaps = needed <= capacity;
  let y = top;
  model.rows.forEach((source, k) => {
    if (y > bottom) return;
    const row = rows[k]!;
    if (gaps && k > 0 && row.header !== undefined) y++;
    if (y > bottom) return;
    if (source.style?.bg) {
      // Preformatted rows with their own background (the pairing QR code)
      // are drawn cell for cell: wrapping would break the pattern.
      canvas.put(l, y, clipText(source.label, r - l + 1), { fg: source.style.fg, bg: source.style.bg });
      y++;
      return;
    }
    const used = drawRow(canvas, y, row, l, r, bottom);
    cut += measureRow(row, l, r) - used;
    y += used;
  });
  return cut;
}

