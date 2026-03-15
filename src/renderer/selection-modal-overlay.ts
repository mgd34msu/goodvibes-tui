import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { SelectionModal } from '../input/selection-modal.ts';

/**
 * Render the selection modal as Line[] for overlay in the viewport.
 * Shows a bordered box with title, fuzzy search input, item list, and action hints.
 */
export function renderSelectionModalOverlay(
  modal: SelectionModal,
  width: number,
): Line[] {
  const lines: Line[] = [];
  const boxMargin = 4;
  const boxW = Math.min(width - boxMargin * 2, 72);
  const contentW = boxW - 4; // 2 border chars + 2 padding chars each side
  const pad = ' '.repeat(boxMargin);

  // ── Title bar ──────────────────────────────────────────────────────────────
  const titleText = `\u2500 ${modal.title} `;
  const titleFill = Math.max(0, boxW - 2 - getDisplayWidth(titleText));
  const titleLine = pad + '\u250c' + titleText + '\u2500'.repeat(titleFill) + '\u2510';
  lines.push(UIFactory.stringToLine(titleLine, width, { fg: '#00ffff' }));

  // ── Search input (always shown when allowSearch is true) ───────────────────
  if (modal.allowSearch) {
    const queryRaw = modal.query;
    const queryDisplay = queryRaw.length > contentW - 3 ? queryRaw.slice(0, contentW - 4) + '\u2026' : queryRaw;
    const searchLine = pad + '\u2502 \u2315 ' + queryDisplay + '\u2588' +
      ' '.repeat(Math.max(0, contentW - queryDisplay.length - 3)) + '\u2502';
    lines.push(UIFactory.stringToLine(searchLine, width, { fg: '252' }));

    // Separator after search
    const sepLine = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    lines.push(UIFactory.stringToLine(sepLine, width, { fg: '240' }));
  } else {
    // Empty separator row
    const emptyRow = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';
    lines.push(UIFactory.stringToLine(emptyRow, width, { fg: '240' }));
  }

  // ── Items list ─────────────────────────────────────────────────────────────
  const items = modal.filteredItems;

  if (items.length === 0) {
    const msg = modal.query ? 'No matching items' : 'No items';
    const noItems = pad + '\u2502 ' + msg.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(noItems, width, { fg: '244', dim: true }));
  } else {
    // Compute visible window: show up to 12 items, centered on selection
    const maxVisible = 12;
    let startIdx = 0;
    if (items.length > maxVisible) {
      startIdx = Math.max(0, Math.min(
        modal.selectedIndex - Math.floor(maxVisible / 2),
        items.length - maxVisible,
      ));
    }
    const endIdx = Math.min(startIdx + maxVisible, items.length);

    // Track last-rendered category to show headers
    let lastCategory: string | undefined = undefined;

    for (let i = startIdx; i < endIdx; i++) {
      const item = items[i];
      const isSelected = i === modal.selectedIndex;

      // Category header
      if (item.category && item.category !== lastCategory) {
        lastCategory = item.category;
        const catText = '  ' + item.category;
        const catLine = pad + '\u2502 ' + catText.padEnd(contentW) + ' \u2502';
        lines.push(UIFactory.stringToLine(catLine, width, { fg: '240', dim: true }));
      }

      const indicator = isSelected ? '\u25b6 ' : '  ';

      // Label + detail layout
      if (item.detail) {
        // Left: label, right: detail right-aligned
        const maxLabelLen = Math.floor(contentW * 0.6) - 2;
        const labelStr = item.label.length > maxLabelLen
          ? item.label.slice(0, maxLabelLen - 1) + '\u2026'
          : item.label;
        const detailSpace = contentW - maxLabelLen - 4; // indicator(2) + gap(2)
        const detailStr = item.detail.length > detailSpace
          ? item.detail.slice(0, detailSpace - 1) + '\u2026'
          : item.detail.padStart(detailSpace);
        const rowText = pad + '\u2502 ' + indicator + labelStr.padEnd(maxLabelLen) + '  ' + detailStr + ' \u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
      } else {
        const labelStr = item.label.length > contentW - 2
          ? item.label.slice(0, contentW - 3) + '\u2026'
          : item.label;
        const rowText = pad + '\u2502 ' + indicator + labelStr.padEnd(contentW - 2) + '\u2502';
        lines.push(UIFactory.stringToLine(rowText, width, {
          fg: isSelected ? '#00ffff' : '252',
          bold: isSelected,
          bg: isSelected ? '#1a2a3a' : '',
        }));
      }
    }

    // Scroll indicator if truncated
    if (items.length > maxVisible) {
      const above = startIdx;
      const below = items.length - endIdx;
      let scrollHint: string;
      if (above > 0 && below > 0) {
        scrollHint = `  (${above} above, ${below} below)`;
      } else if (below > 0) {
        scrollHint = `  (${below} below)`;
      } else {
        scrollHint = `  (${above} above)`;
      }
      const hintLine = pad + '\u2502 ' + scrollHint.padEnd(contentW) + ' \u2502';
      lines.push(UIFactory.stringToLine(hintLine, width, { fg: '240', dim: true }));
    }
  }

  // ── Bottom border with action hints ───────────────────────────────────────
  // Build hint string including custom actions
  let hints = ' [\u2191\u2193] Navigate  [Enter] Select  [Esc] Close';
  if (modal.allowSearch) {
    hints += '  [type to search]';
  }

  // Add custom action hints from a selected item
  const selectedItem = modal.getSelected();
  if (selectedItem?.actions) {
    hints += `  ${selectedItem.actions}`;
  }
  hints += ' ';

  const bottomFill = Math.max(0, boxW - 2 - getDisplayWidth(hints));
  const bottomLine = pad + '\u2514' + hints + '\u2500'.repeat(bottomFill) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  return lines;
}
