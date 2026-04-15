import { type Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';
import type { SelectionModal } from '../input/selection-modal.ts';
import {
  createOverlayBoxLayout,
  createOverlayContentLine,
  createOverlayFilledBorderLine,
  DEFAULT_OVERLAY_PALETTE,
  OVERLAY_GLYPHS,
  putOverlayText,
} from './overlay-box.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';
import { fitLabelDetailColumns, wrapWithHangingIndent } from './text-layout.ts';

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

  lines.push(createOverlayFilledBorderLine(width, layout, OVERLAY_GLYPHS.topLeft, OVERLAY_GLYPHS.horizontal, OVERLAY_GLYPHS.topRight, BORDER_FG, DEFAULT_OVERLAY_PALETTE.titleBg));

  const titleLine = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.titleBg);
  putText(
    titleLine,
    layout.margin + 2,
    layout.innerWidth,
    fitDisplay(truncateDisplay(modal.title, layout.innerWidth), layout.innerWidth),
    { fg: TITLE_FG, bold: true },
  );
  lines.push(titleLine);

  if (modal.allowSearch) {
    const labelLine = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg);
    putText(labelLine, layout.margin + 2, layout.innerWidth, fitDisplay(' Search', layout.innerWidth), {
      fg: CATEGORY_FG,
      dim: true,
    });
    lines.push(labelLine);
    const searchLine = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.inputBg);
    const prefix = '/ ';
    const queryAreaWidth = layout.innerWidth - getDisplayWidth(prefix);
    const queryValue = modal.query + (modal.searchFocused ? OVERLAY_GLYPHS.cursor : '');
    const queryText = fitDisplay(
      truncateDisplay(queryValue, queryAreaWidth),
      queryAreaWidth,
    );
    putText(searchLine, layout.margin + 2, getDisplayWidth(prefix), prefix, { fg: modal.searchFocused ? BODY_FG : MUTED_FG });
    putText(searchLine, layout.margin + 2 + getDisplayWidth(prefix), queryAreaWidth, queryText, {
      fg: modal.query.length > 0 || modal.searchFocused ? BODY_FG : MUTED_FG,
    });
    lines.push(searchLine);
    lines.push(createOverlayFilledBorderLine(width, layout, OVERLAY_GLYPHS.teeLeft, OVERLAY_GLYPHS.horizontal, OVERLAY_GLYPHS.teeRight, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg));
  } else {
    lines.push(createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg));
  }

  const listTitle = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg);
  putText(listTitle, layout.margin + 2, layout.innerWidth, fitDisplay(' Results', layout.innerWidth), {
    fg: CATEGORY_FG,
    dim: true,
  });
  lines.push(listTitle);

  const items = modal.filteredItems;
  if (items.length === 0) {
    const line = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.bodyBg);
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
        const categoryLine = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg);
        putText(categoryLine, layout.margin + 2, layout.innerWidth, fitDisplay(`  ${item.category}`, layout.innerWidth), {
          fg: CATEGORY_FG,
          dim: true,
        });
        lines.push(categoryLine);
      }

      const indicator = isSelected ? `${OVERLAY_GLYPHS.selected} ` : '  ';
      const indicatorWidth = 2;
      const remaining = layout.innerWidth - indicatorWidth;
      const labelColor = isSelected ? TITLE_FG : (item.fg ?? BODY_FG);
      const detailColor = isSelected ? BODY_FG : MUTED_FG;
      const labelWidth = item.detail
        ? fitLabelDetailColumns(item.label, item.detail, remaining).labelWidth
        : remaining;
      const labelLine = createOverlayContentLine(width, layout, BORDER_FG, isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg);
        putText(labelLine, layout.margin + 2, indicatorWidth, indicator, {
          fg: isSelected ? TITLE_FG : MUTED_FG,
          bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
          bold: isSelected,
        });
      putText(labelLine, layout.margin + 2 + indicatorWidth, labelWidth, fitDisplay(truncateDisplay(item.label, labelWidth), labelWidth), {
        fg: labelColor,
        bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
        bold: isSelected,
      });
      if (item.detail) {
          const detailWidth = fitLabelDetailColumns(item.label, item.detail, remaining).detailWidth;
        if (detailWidth >= 12) {
          putText(labelLine, layout.margin + 2 + indicatorWidth + labelWidth, 2, '  ', {
            fg: BODY_FG,
            bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
          });
          putText(labelLine, layout.margin + 2 + indicatorWidth + labelWidth + 2, detailWidth, fitDisplay(truncateDisplay(item.detail, detailWidth), detailWidth), {
            fg: detailColor,
            bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
          });
          lines.push(labelLine);
        } else {
          lines.push(labelLine);
          const wrappedDetails = wrapWithHangingIndent(item.detail, Math.max(8, remaining), '', 2);
          for (const detailLineText of wrappedDetails) {
            const detailLine = createOverlayContentLine(width, layout, BORDER_FG, isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg);
            putText(detailLine, layout.margin + 2 + indicatorWidth, remaining, fitDisplay(truncateDisplay(detailLineText, remaining), remaining), {
              fg: detailColor,
              bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
              dim: !isSelected,
            });
            lines.push(detailLine);
          }
        }
      } else {
        lines.push(labelLine);
      }
    }

    if (items.length > maxVisible) {
      const above = startIdx;
      const below = items.length - endIdx;
      const scrollHint = above > 0 && below > 0
        ? `(${above} above, ${below} below)`
        : below > 0
        ? `(${below} below)`
        : `(${above} above)`;
      const hintLine = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg);
      putText(hintLine, layout.margin + 2, layout.innerWidth, fitDisplay(scrollHint, layout.innerWidth), { fg: MUTED_FG, dim: true });
      lines.push(hintLine);
    }
  }

  const footerLine = createOverlayContentLine(width, layout, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg);
  const selectedItem = modal.getSelected();
  const primaryVerb = selectedItem?.primaryAction === 'toggle'
    ? '[Enter] Toggle'
    : selectedItem?.primaryAction === 'edit'
    ? '[Enter] Edit'
    : selectedItem?.primaryAction === 'delete'
    ? '[Enter] Delete'
    : '[Enter] Select';
  let hints = `[Up/Down] Navigate  ${primaryVerb}  [Esc] Close`;
  if (modal.allowSearch) hints += '  [/] Search';
  if (selectedItem?.primaryAction === 'toggle' && !selectedItem.actions) hints += '  [Space] Toggle';
  if (selectedItem?.actions) hints += `  ${selectedItem.actions}`;
  putText(
    footerLine,
    layout.margin + 2,
    layout.innerWidth,
    fitDisplay(truncateDisplay(hints, layout.innerWidth), layout.innerWidth),
    { fg: MUTED_FG, dim: true },
  );
  lines.push(footerLine);
  lines.push(createOverlayFilledBorderLine(width, layout, OVERLAY_GLYPHS.bottomLeft, OVERLAY_GLYPHS.horizontal, OVERLAY_GLYPHS.bottomRight, BORDER_FG, DEFAULT_OVERLAY_PALETTE.sectionBg));

  return lines;
}
