import { type Line } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { PanelPicker } from '../panels/panel-picker.ts';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../panels/panel-picker.ts';
import type { PanelCategory, PanelRegistration } from '../panels/types.ts';
import {
  createOverlayBorderLine,
  createOverlayBoxLayout,
  createOverlayContentLine,
  putOverlayText,
} from './overlay-box.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';

const TITLE_FG = '#cbd5e1';
const CATEGORY_FG = '#94a3b8';
const SELECTED_FG = '#e2e8f0';
const SELECTED_BG = '#1e293b';
const BODY_FG = '252';

/**
 * Render the panel picker modal as Line[] for overlay in the viewport.
 * Panels are grouped by category. Category headers are inserted between groups.
 * When a search query is active a search-bar row is shown beneath the title.
 */
export function renderPanelPickerOverlay(
  picker: PanelPicker,
  width: number,
  viewportHeight = 24,
): Line[] {
  if (!picker.active) return [];

  const lines: Line[] = [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 4,
    maxWidth: 72,
    chromeRows: picker.searchQuery.length > 0 ? 7 : 6,
    minContentRows: 6,
    maxContentRows: 10,
  });
  const layout = createOverlayBoxLayout(width, metrics.margin, metrics.boxWidth);
  const contentW = layout.innerWidth;
  const titleFg = TITLE_FG;
  const borderFg = '240';

  // ── Title bar ──────────────────────────────────────────────────────────────
  const titleLine = createOverlayBorderLine(width, layout, '┌', '─', '┐', titleFg);
  putOverlayText(titleLine, layout.margin + 2, layout.width - 4, 'Open Panel Workspace', { fg: titleFg, bold: true });
  lines.push(titleLine);

  // ── Search bar (shown when query is non-empty) ──────────────────────────────
  if (picker.searchQuery.length > 0) {
    const searchLine = createOverlayContentLine(width, layout, borderFg);
    const searchLabel = '\u2315 ';
    const queryAvail = contentW - getDisplayWidth(searchLabel);
    const queryText = fitDisplay(picker.searchQuery, queryAvail);
    putOverlayText(searchLine, layout.margin + 2, getDisplayWidth(searchLabel), searchLabel, { fg: titleFg });
    putOverlayText(searchLine, layout.margin + 2 + getDisplayWidth(searchLabel), queryAvail, queryText, { fg: titleFg });
    lines.push(searchLine);

    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));
  } else {
    const placeholder = ' Browse by category or start typing to filter by panel name, purpose, or category.';
    const row = createOverlayContentLine(width, layout, borderFg);
    putOverlayText(row, layout.margin + 2, contentW, fitDisplay(placeholder, contentW), { fg: '244', dim: true });
    lines.push(row);
  }

  const visible = picker.getVisible();

  if (visible.length === 0) {
    const noResults = 'No panels match your search';
    const noRow = createOverlayContentLine(width, layout, borderFg);
    putOverlayText(noRow, layout.margin + 2, contentW, fitDisplay(noResults, contentW), { fg: '244', dim: true });
    lines.push(noRow);
  } else {
    // Build a flat render list of { type: 'header' | 'item', ... } entries
    // so we can compute the correct scroll window over all rows.
    type HeaderEntry = { type: 'header'; category: PanelCategory };
    type ItemEntry   = { type: 'item';   reg: PanelRegistration; flatIndex: number };
    type RenderEntry = HeaderEntry | ItemEntry;

    const renderEntries: RenderEntry[] = [];

    // When no search query, group by category; when searching, show flat list
    // with a single "Results" header.
    if (picker.searchQuery.length === 0) {
      const byCategory = new Map<PanelCategory, PanelRegistration[]>();
      for (const reg of visible) {
        const group = byCategory.get(reg.category) ?? [];
        group.push(reg);
        byCategory.set(reg.category, group);
      }
      let flatIndex = 0;
      for (const cat of CATEGORY_ORDER) {
        const group = byCategory.get(cat);
        if (!group || group.length === 0) continue;
        renderEntries.push({ type: 'header', category: cat });
        for (const reg of group) {
          renderEntries.push({ type: 'item', reg, flatIndex });
          flatIndex++;
        }
      }
    } else {
      for (let i = 0; i < visible.length; i++) {
        renderEntries.push({ type: 'item', reg: visible[i], flatIndex: i });
      }
    }

    // Compute scroll window: ensure the selected item row stays visible.
    // Find the render-entry index of the selected item.
    const selectedEntryIdx = renderEntries.findIndex(
      e => e.type === 'item' && e.flatIndex === picker.selectedIndex,
    );
    const total = renderEntries.length;
    const maxVisible = metrics.contentRows;
    let startEntry = 0;
    if (total > maxVisible && selectedEntryIdx >= 0) {
      startEntry = Math.max(
        0,
        Math.min(
          selectedEntryIdx - Math.floor(maxVisible / 2),
          total - maxVisible,
        ),
      );
    }
    const endEntry = Math.min(startEntry + maxVisible, total);

    for (let i = startEntry; i < endEntry; i++) {
      const entry = renderEntries[i];

      if (entry.type === 'header') {
        // Category header row
        const label = CATEGORY_LABELS[entry.category].toUpperCase();
        const headerRow = createOverlayContentLine(width, layout, borderFg);
        putOverlayText(headerRow, layout.margin + 2, contentW, fitDisplay(`  ${label}`, contentW), { fg: CATEGORY_FG, dim: true });
        lines.push(headerRow);
      } else {
        const { reg, flatIndex } = entry;
        const isSelected = flatIndex === picker.selectedIndex;
        const indicator = isSelected ? '\u25b6 ' : '  ';

        // icon (1 char) + 2 spaces + name
        const iconStr = reg.icon + '  ';
        const iconW = getDisplayWidth(iconStr);

        // separator between name and description: ' \u2014 '
        const sep = ' \u2014 ';
        const sepW = getDisplayWidth(sep);

        // Allocate space: indicator(2) + icon(iconW) + name + sep + desc fills contentW
        const nameMaxW = Math.max(8, Math.floor((contentW - 2 - iconW - sepW) * 0.35));
        const descMaxW = contentW - 2 - iconW - nameMaxW - sepW;

        const nameRaw = reg.name;
        const nameStr = fitDisplay(nameRaw, nameMaxW);

        const descRaw = reg.description;
        const descStr = fitDisplay(descRaw, descMaxW);

        const row = createOverlayContentLine(width, layout, borderFg, isSelected ? SELECTED_BG : '');
        const rowText = indicator + iconStr + nameStr + sep + descStr;
        putOverlayText(row, layout.margin + 2, contentW, fitDisplay(truncateDisplay(rowText, contentW), contentW), {
          fg: isSelected ? SELECTED_FG : BODY_FG,
          bg: isSelected ? SELECTED_BG : '',
          bold: isSelected,
        });
        lines.push(row);
      }
    }

    const selected = picker.getSelected();
    if (selected) {
      lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', borderFg));
      const categoryLabel = CATEGORY_LABELS[selected.category].toUpperCase();
      const selectedLine = createOverlayContentLine(width, layout, borderFg);
      putOverlayText(selectedLine, layout.margin + 2, contentW, fitDisplay(`${selected.icon} ${selected.name}  [${categoryLabel}]`, contentW), { fg: SELECTED_FG });
      lines.push(selectedLine);
      const desc = fitDisplay(truncateDisplay(selected.description, contentW), contentW);
      const descRow = createOverlayContentLine(width, layout, borderFg);
      putOverlayText(descRow, layout.margin + 2, contentW, desc, { fg: '244', dim: true });
      lines.push(descRow);
    }

    // ── Scroll indicator ───────────────────────────────────────────────────
    if (total > maxVisible) {
      const scrollInfo = `${picker.selectedIndex + 1}/${visible.length}`;
      const scrollRow = createOverlayContentLine(width, layout, borderFg);
      putOverlayText(scrollRow, layout.margin + 2 + Math.max(0, contentW - getDisplayWidth(scrollInfo)), getDisplayWidth(scrollInfo), scrollInfo, { fg: '240', dim: true });
      lines.push(scrollRow);
    }
  }

  // ── Bottom border with hints ───────────────────────────────────────────────
  const hints = '[Up/Down] Navigate  [Enter] Open  [/] Filter  [Esc] Cancel';
  const bottomLine = createOverlayBorderLine(width, layout, '└', '─', '┘', borderFg);
  putOverlayText(bottomLine, layout.margin + 2, layout.width - 4, truncateDisplay(hints, layout.width - 4), { fg: '240', dim: true });
  lines.push(bottomLine);

  return lines;
}
