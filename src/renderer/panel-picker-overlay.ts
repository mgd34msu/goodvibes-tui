import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { PanelPicker } from '../panels/panel-picker.ts';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../panels/panel-picker.ts';
import type { PanelCategory, PanelRegistration } from '../panels/types.ts';

/** Maximum number of content rows (items + category headers) visible at once. */
const MAX_VISIBLE = 12;

/** Dim purple used for category header text. */
const CATEGORY_FG = '#8877aa';

/**
 * Render the panel picker modal as Line[] for overlay in the viewport.
 * Panels are grouped by category. Category headers are inserted between groups.
 * When a search query is active a search-bar row is shown beneath the title.
 */
export function renderPanelPickerOverlay(
  picker: PanelPicker,
  width: number,
): Line[] {
  if (!picker.active) return [];

  const lines: Line[] = [];
  const boxMargin = 4;
  const boxW = Math.max(4, Math.min(width - boxMargin * 2, 72));
  const contentW = boxW - 4; // 2 border chars + 2 padding chars each side
  const pad = ' '.repeat(boxMargin);

  const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';

  // ── Title bar ──────────────────────────────────────────────────────────────
  const titleText = '\u2500 Select Panel ';
  const titleLine =
    pad + '\u250c' + titleText + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(titleText))) + '\u2510';
  lines.push(UIFactory.stringToLine(titleLine, width, { fg: '#00ffff' }));

  // ── Search bar (shown when query is non-empty) ──────────────────────────────
  if (picker.searchQuery.length > 0) {
    const searchLabel = '\u2315 ';
    const queryAvail = contentW - getDisplayWidth(searchLabel);
    const queryText = picker.searchQuery.length > queryAvail
      ? picker.searchQuery.slice(0, queryAvail - 1) + '\u2026'
      : picker.searchQuery.padEnd(queryAvail);
    const searchRow = pad + '\u2502 ' + searchLabel + queryText + ' \u2502';
    lines.push(UIFactory.stringToLine(searchRow, width, { fg: '#00ffff' }));

    const searchDivider = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(searchDivider, width, { fg: '240' }));
  } else {
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  }

  const visible = picker.getVisible();

  if (visible.length === 0) {
    const noResults = 'No panels match your search';
    const noRow = pad + '\u2502 ' + noResults.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(noRow, width, { fg: '244', dim: true }));
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
    let startEntry = 0;
    if (total > MAX_VISIBLE && selectedEntryIdx >= 0) {
      startEntry = Math.max(
        0,
        Math.min(
          selectedEntryIdx - Math.floor(MAX_VISIBLE / 2),
          total - MAX_VISIBLE,
        ),
      );
    }
    const endEntry = Math.min(startEntry + MAX_VISIBLE, total);

    for (let i = startEntry; i < endEntry; i++) {
      const entry = renderEntries[i];

      if (entry.type === 'header') {
        // Category header row — dim purple, no border padding detail
        const label = CATEGORY_LABELS[entry.category].toUpperCase();
        const headerText = '  ' + label + ' ';
        const headerFill = '\u2500'.repeat(Math.max(0, contentW - getDisplayWidth(headerText)));
        const headerRow = pad + '\u2502 ' + headerText + headerFill + ' \u2502';
        lines.push(UIFactory.stringToLine(headerRow, width, { fg: CATEGORY_FG, dim: true }));
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
        const nameStr = nameRaw.length > nameMaxW
          ? nameRaw.slice(0, nameMaxW - 1) + '\u2026'
          : nameRaw.padEnd(nameMaxW);

        const descRaw = reg.description;
        const descStr = descRaw.length > descMaxW
          ? descRaw.slice(0, descMaxW - 1) + '\u2026'
          : descRaw.padEnd(descMaxW);

        const rowText = pad + '\u2502 ' + indicator + iconStr + nameStr + sep + descStr + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
      }
    }

    // ── Scroll indicator ───────────────────────────────────────────────────
    if (total > MAX_VISIBLE) {
      const scrollInfo = `${picker.selectedIndex + 1}/${visible.length}`;
      const scrollRow =
        pad + '\u2502' +
        ' '.repeat(Math.max(0, boxW - 2 - getDisplayWidth(scrollInfo) - 1)) +
        scrollInfo + ' \u2502';
      lines.push(UIFactory.stringToLine(scrollRow, width, { fg: '240', dim: true }));
    }
  }

  // ── Bottom border with hints ───────────────────────────────────────────────
  const hints = ' [\u2191\u2193] Navigate  [Enter] Open  [/] Search  [Esc] Cancel ';
  const bottomLine =
    pad + '\u2514' + hints + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(hints))) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  return lines;
}
