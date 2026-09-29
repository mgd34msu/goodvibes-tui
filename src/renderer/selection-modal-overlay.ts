/**
 * renderSelectionModalOverlay, the generic picker (used by many commands and
 * by the startup recovery questions), drawn with the modal surface kit.
 *
 * Title row, the always-live search row (when the picker searches), items as
 * kit rows grouped under ✦ category headers, the selected item as the
 * gradient row, details wrapped in full after the label, a muted scroll count
 * and keycap hints. The modal sizes to its content: a short question is a
 * small centered dialog that shows every answer; a long list takes the
 * standard height and scrolls around the selected row.
 */

import type { SelectionItem, SelectionModal } from '../input/selection-modal.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  drawWrapped,
  finishModal,
  maxModalHeight,
  searchRow,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { kitHintsFromStrings, listHeight, modalHeightFor, modalTextWidth } from './surface-kit-extra.ts';

function primaryVerb(modal: SelectionModal, item: SelectionItem | null): string {
  if (modal.primaryVerbLabel) return modal.primaryVerbLabel.toLowerCase();
  switch (item?.primaryAction) {
    case 'toggle': return 'toggle';
    case 'edit': return 'edit';
    case 'delete': return 'delete';
    default: return 'select';
  }
}

function hintsFor(modal: SelectionModal): KitHint[] {
  const item = modal.getSelected();
  const base: KitHint[] = [['↑↓', 'move'], ['⏎', primaryVerb(modal, item)]];
  if (item?.primaryAction === 'toggle' && !item.actions) base.push(['space', 'toggle']);
  if (item?.adjustable) base.push(['←→', 'adjust']);
  // Item action strings are legacy "[d] delete" / "d delete" text; each one
  // becomes a keycap. Several may share one string separated by spaces.
  const actionStrings = item?.actions ? splitActionString(item.actions) : [];
  return kitHintsFromStrings(actionStrings, base).hints;
}

/** "[d] delete  [r] rename" → ["[d] delete", "[r] rename"]. */
function splitActionString(text: string): string[] {
  const bracketed = text.match(/\[[^\]]+\][^[]*/g);
  if (bracketed && bracketed.length > 0) return bracketed.map((part) => part.trim());
  return text.split(/\s{2,}|\s·\s/).map((part) => part.trim()).filter(Boolean);
}

function rowsFor(items: readonly SelectionItem[], selectedIndex: number): KitRow[] {
  const rows: KitRow[] = [];
  let lastCategory: string | undefined;
  items.forEach((item, index) => {
    if (item.category && item.category !== lastCategory) {
      lastCategory = item.category;
      rows.push({ header: item.category });
    }
    rows.push({
      label: item.label,
      desc: item.detail,
      selected: index === selectedIndex,
      labelFg: item.fg,
    });
  });
  return rows;
}

/**
 * Render the selection modal as a SurfaceLayer in screen coordinates.
 */
export function renderSelectionModalOverlay(
  modal: SelectionModal,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer {
  const t = activeTokens();
  const hints = hintsFor(modal);
  const rows = rowsFor(modal.filteredItems, modal.selectedIndex);
  const textWidth = modalTextWidth(screenWidth, screenHeight);
  // Size to every item (not the filtered set) so typing never resizes the
  // modal; measure against the same text span drawList uses.
  const allRows = rowsFor(modal.items, -1);
  const needed = allRows.length === 0 ? 1 : listHeight(allRows, 0, textWidth - 1);
  const searchRows = modal.allowSearch ? 2 : 0;
  const height = modalHeightFor(screenWidth, screenHeight, { hints }, searchRows + needed);
  // A short picker (it fits well inside the screen) is a small centered dialog.
  const center = height <= Math.round(maxModalHeight(screenHeight) * 0.6);
  const f = beginModal(screenWidth, screenHeight, { title: modal.title, hints, height, center });

  let top = f.top;
  if (modal.allowSearch) {
    const total = modal.items.length;
    const count = modal.query.length > 0
      ? `${modal.filteredItems.length} of ${total}`
      : `${total} ${total === 1 ? 'item' : 'items'}`;
    searchRow(f, top, modal.query, 'Type to filter', count);
    top += 2;
  }

  if (rows.length === 0) {
    const message = modal.query ? 'No matching items' : 'No items';
    drawWrapped(f.canvas, f.l, top, f.r - f.l + 1, message, { fg: t.textMuted }, f.bottom);
    return finishModal(f);
  }

  const res = drawList(f.canvas, { rows, top, bottom: f.bottom, x0: f.l, x1: f.r });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
