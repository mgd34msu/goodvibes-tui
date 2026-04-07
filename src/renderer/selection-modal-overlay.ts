import { type Line } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { SelectionModal } from '../input/selection-modal.ts';
import {
  createOverlayBorderLine,
  createOverlayBoxLayout,
  createOverlayContentLine,
  DEFAULT_OVERLAY_PALETTE,
  putOverlayText,
} from './overlay-box.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';

const BORDER_FG = DEFAULT_OVERLAY_PALETTE.borderFg;
const TITLE_FG = DEFAULT_OVERLAY_PALETTE.titleFg;
const BODY_FG = DEFAULT_OVERLAY_PALETTE.bodyFg;
const MUTED_FG = DEFAULT_OVERLAY_PALETTE.mutedFg;
const CATEGORY_FG = '#4488cc';
const SELECTED_BG = DEFAULT_OVERLAY_PALETTE.selectedBg;

interface CellStyle {
  fg: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

function putText(line: Line, startX: number, maxWidth: number, text: string, style: CellStyle): void {
  putOverlayText(line, startX, maxWidth, text, style);
}

/**
 * Render the selection modal as Line[] for overlay in the viewport.
 */
export function renderSelectionModalOverlay(
  modal: SelectionModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const lines: Line[] = [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 4,
    maxWidth: 72,
    chromeRows: modal.allowSearch ? 5 : 4,
    minContentRows: 6,
    maxContentRows: 10,
  });
  const layout = createOverlayBoxLayout(width, metrics.margin, metrics.boxWidth);

  lines.push(createOverlayBorderLine(width, layout, '┌', '─', '┐'));

  const titleLine = createOverlayContentLine(width, layout);
  putText(
    titleLine,
    layout.margin + 2,
    layout.innerWidth,
    fitDisplay(truncateDisplay(modal.title, layout.innerWidth), layout.innerWidth),
    { fg: TITLE_FG, bold: true },
  );
  lines.push(titleLine);

  if (modal.allowSearch) {
    const searchLine = createOverlayContentLine(width, layout);
    const prefix = '/ ';
    const queryAreaWidth = layout.innerWidth - getDisplayWidth(prefix);
    const queryText = fitDisplay(
      truncateDisplay(`${modal.query}_`, queryAreaWidth),
      queryAreaWidth,
    );
    putText(searchLine, layout.margin + 2, getDisplayWidth(prefix), prefix, { fg: BODY_FG });
    putText(searchLine, layout.margin + 2 + getDisplayWidth(prefix), queryAreaWidth, queryText, {
      fg: modal.query.length > 0 ? BODY_FG : MUTED_FG,
    });
    lines.push(searchLine);
    lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', MUTED_FG));
  } else {
    lines.push(createOverlayContentLine(width, layout));
  }

  const items = modal.filteredItems;
  if (items.length === 0) {
    const line = createOverlayContentLine(width, layout);
    const message = modal.query ? 'No matching items' : 'No items';
    putText(line, layout.margin + 2, layout.innerWidth, fitDisplay(message, layout.innerWidth), { fg: MUTED_FG, dim: true });
    lines.push(line);
  } else {
    const maxVisible = metrics.contentRows;
    let startIdx = 0;
    if (items.length > maxVisible) {
      startIdx = Math.max(0, Math.min(
        modal.selectedIndex - Math.floor(maxVisible / 2),
        items.length - maxVisible,
      ));
    }
    const endIdx = Math.min(startIdx + maxVisible, items.length);
    let lastCategory: string | undefined;

    for (let i = startIdx; i < endIdx; i++) {
      const item = items[i];
      const isSelected = i === modal.selectedIndex;

      if (item.category && item.category !== lastCategory) {
        lastCategory = item.category;
        const categoryLine = createOverlayContentLine(width, layout);
        putText(categoryLine, layout.margin + 2, layout.innerWidth, fitDisplay(`  ${item.category}`, layout.innerWidth), {
          fg: CATEGORY_FG,
          dim: true,
        });
        lines.push(categoryLine);
      }

      const row = createOverlayContentLine(width, layout, BORDER_FG, isSelected ? SELECTED_BG : '');
      const indicator = isSelected ? '> ' : '  ';
      const indicatorWidth = 2;
      putText(row, layout.margin + 2, indicatorWidth, indicator, {
        fg: isSelected ? TITLE_FG : MUTED_FG,
        bg: isSelected ? SELECTED_BG : '',
        bold: isSelected,
      });

      let x = layout.margin + 2 + indicatorWidth;
      const remaining = layout.innerWidth - indicatorWidth;
      if (item.detail) {
        const labelWidth = Math.max(10, Math.floor(remaining * 0.6) - 2);
        const detailWidth = Math.max(0, remaining - labelWidth - 2);
        putText(row, x, labelWidth, fitDisplay(truncateDisplay(item.label, labelWidth), labelWidth), {
          fg: isSelected ? TITLE_FG : (item.fg ?? BODY_FG),
          bg: isSelected ? SELECTED_BG : '',
          bold: isSelected,
        });
        x += labelWidth;
        putText(row, x, 2, '  ', {
          fg: BODY_FG,
          bg: isSelected ? SELECTED_BG : '',
        });
        x += 2;
        putText(row, x, detailWidth, fitDisplay(truncateDisplay(item.detail, detailWidth), detailWidth), {
          fg: isSelected ? BODY_FG : MUTED_FG,
          bg: isSelected ? SELECTED_BG : '',
        });
      } else {
        putText(row, x, remaining, fitDisplay(truncateDisplay(item.label, remaining), remaining), {
          fg: isSelected ? TITLE_FG : (item.fg ?? BODY_FG),
          bg: isSelected ? SELECTED_BG : '',
          bold: isSelected,
        });
      }
      lines.push(row);
    }

    if (items.length > maxVisible) {
      const above = startIdx;
      const below = items.length - endIdx;
      const scrollHint = above > 0 && below > 0
        ? `(${above} above, ${below} below)`
        : below > 0
        ? `(${below} below)`
        : `(${above} above)`;
      const hintLine = createOverlayContentLine(width, layout);
      putText(hintLine, layout.margin + 2, layout.innerWidth, fitDisplay(scrollHint, layout.innerWidth), { fg: MUTED_FG, dim: true });
      lines.push(hintLine);
    }
  }

  const footerLine = createOverlayContentLine(width, layout);
  let hints = '[Up/Down] Navigate  [Enter] Select  [Esc] Close';
  if (modal.allowSearch) hints += '  [type to search]';
  const selectedItem = modal.getSelected();
  if (selectedItem?.actions) hints += `  ${selectedItem.actions}`;
  putText(
    footerLine,
    layout.margin + 2,
    layout.innerWidth,
    fitDisplay(truncateDisplay(hints, layout.innerWidth), layout.innerWidth),
    { fg: MUTED_FG, dim: true },
  );
  lines.push(footerLine);
  lines.push(createOverlayBorderLine(width, layout, '└', '─', '┘', MUTED_FG));

  return lines;
}
