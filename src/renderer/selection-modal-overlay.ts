import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { SelectionItem, SelectionModal } from '../input/selection-modal.ts';
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
 * How an item's `detail` text fits on screen. Descriptive text is never
 * clipped: if it doesn't fit beside the label at a readable width, the full
 * text wraps onto its own line(s) below the label instead of being
 * truncated. `wrappedDetail` is null when the detail fits inline (no data
 * lost either way); otherwise it holds every wrapped line the FULL detail
 * needs (no line-count cap).
 */
interface DetailLayout {
  readonly labelWidth: number;
  readonly detailWidth: number;
  readonly wrappedDetail: readonly string[] | null;
}

function computeDetailLayout(item: SelectionItem, remaining: number): DetailLayout {
  if (!item.detail) {
    return { labelWidth: remaining, detailWidth: 0, wrappedDetail: null };
  }
  const cols = fitLabelDetailColumns(item.label, item.detail, remaining);
  const fitsInline = cols.detailWidth >= 12 && getDisplayWidth(item.detail) <= cols.detailWidth;
  if (fitsInline) {
    return { labelWidth: cols.labelWidth, detailWidth: cols.detailWidth, wrappedDetail: null };
  }
  // Nothing shares this row with the label once the detail moves below it,
  // so the label itself gets the full row width too.
  return {
    labelWidth: remaining,
    detailWidth: cols.detailWidth,
    wrappedDetail: wrapWithHangingIndent(item.detail, Math.max(8, remaining), ''),
  };
}

/** Physical rows an item occupies: 1 for the label/inline-detail row, plus
 * one more per wrapped detail line when the detail didn't fit inline. */
function rowCostFor(item: SelectionItem, remaining: number): number {
  if (!item.detail) return 1;
  return 1 + (computeDetailLayout(item, remaining).wrappedDetail?.length ?? 0);
}

const MODAL_MARGIN = 4;
const MODAL_MAX_WIDTH = 72;
const INDICATOR_WIDTH = 2;
/** Rows kept clear between the box and the top/bottom of the terminal. */
const VIEWPORT_INSET_ROWS = 2;

/**
 * Rows the box spends on its own frame, counted as they are actually pushed
 * below: top and bottom border, the title, the section row (a search label,
 * search input and divider when the modal searches), the "Results" header and
 * the footer hint. `chromeRows` is the budget-math constant the surface
 * metrics subtract from a total; this is the physical count, and it is what
 * decides how tall the box may really grow.
 */
function frameRowsFor(modal: SelectionModal): number {
  return modal.allowSearch ? 8 : 6;
}

/**
 * Physical rows every row of the list needs, category headers included, the
 * height the box would have to give the list for nothing to be scrolled away.
 */
function totalContentRowsFor(modal: SelectionModal, remaining: number): number {
  let rows = 0;
  let lastCategory: string | undefined;
  for (const item of modal.filteredItems) {
    if (item.category && item.category !== lastCategory) {
      lastCategory = item.category;
      rows += 1;
    }
    rows += rowCostFor(item, remaining);
  }
  return rows;
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
  const chromeRows = modal.allowSearch ? 5 : 4;
  // Width does not depend on the row budget, so the box layout is settled
  // first: the list's real height can only be measured once the wrap width is
  // known. `createOverlayBoxLayout` resolves the requested max width the same
  // way `getOverlaySurfaceMetrics` does, so both agree on the box.
  const layout = createOverlayBoxLayout(width, MODAL_MARGIN, MODAL_MAX_WIDTH);
  const remaining = layout.innerWidth - INDICATOR_WIDTH;

  // Size to content before falling back to the viewport's height ratio. When
  // every row (and its wrapped detail) fits in the space the terminal
  // actually has, ask for exactly that many rows, so a short list is never
  // split behind a "(n below)" hint with screen still empty below the box,
  // a two-item question in particular must always show both its answers. A
  // list genuinely taller than the terminal keeps the ratio-derived budget
  // and scrolls as before.
  const neededContentRows = totalContentRowsFor(modal, remaining);
  const fittableContentRows = viewportHeight - VIEWPORT_INSET_ROWS - frameRowsFor(modal);
  const growToFitTotalRows = neededContentRows > 0 && neededContentRows <= fittableContentRows
    ? neededContentRows + chromeRows
    : undefined;

  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: MODAL_MARGIN,
    maxWidth: MODAL_MAX_WIDTH,
    chromeRows,
    minContentRows: 6,
    // Modals size to content: items whose detail wraps onto extra lines can
    // need more physical rows than a plain one-row-per-item modal, so this
    // ceiling grows with the viewport rather than staying pinned at a small
    // constant (still bounded, never larger than the terminal can show).
    maxContentRows: Math.max(10, viewportHeight - chromeRows - 4),
    // A floor only. The shared budget keeps its own target and ceiling, so a
    // modal whose content is shorter than that target is unaffected: this can
    // raise the budget to fit the list, never lower it.
    minTotalRows: growToFitTotalRows,
  });

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
    const rowBudget = Math.max(1, metrics.contentRows);

    // Row-budget-aware windowing: rather than assuming one physical row per
    // item, account for items whose detail wraps onto extra lines, so the
    // visible window never silently shows fewer full items than the budget
    // allows just because a fixed item-count cap ran out. Always shows the
    // selected item (even alone, if its wrapped detail is taller than the
    // whole budget, descriptive text is never clipped to make it fit),
    // then grows outward, roughly centered, until the budget is spent.
    const selected = Math.max(0, Math.min(modal.selectedIndex, items.length - 1));
    let startIdx = selected;
    let endIdx = selected + 1;
    let usedRows = rowCostFor(items[selected], remaining);
    let growBefore = true;
    while (startIdx > 0 || endIdx < items.length) {
      const canGrowBefore = growBefore && startIdx > 0;
      const canGrowAfter = !growBefore && endIdx < items.length;
      if (canGrowBefore) {
        const cost = rowCostFor(items[startIdx - 1], remaining);
        if (usedRows + cost > rowBudget) break;
        startIdx -= 1;
        usedRows += cost;
      } else if (canGrowAfter) {
        const cost = rowCostFor(items[endIdx], remaining);
        if (usedRows + cost > rowBudget) break;
        endIdx += 1;
        usedRows += cost;
      } else if (startIdx > 0) {
        const cost = rowCostFor(items[startIdx - 1], remaining);
        if (usedRows + cost > rowBudget) break;
        startIdx -= 1;
        usedRows += cost;
      } else if (endIdx < items.length) {
        const cost = rowCostFor(items[endIdx], remaining);
        if (usedRows + cost > rowBudget) break;
        endIdx += 1;
        usedRows += cost;
      } else {
        break;
      }
      growBefore = !growBefore;
    }

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
      const labelColor = isSelected ? TITLE_FG : (item.fg ?? BODY_FG);
      const detailColor = isSelected ? BODY_FG : MUTED_FG;
      const detailLayout = computeDetailLayout(item, remaining);
      const labelWidth = detailLayout.labelWidth;
      const labelLine = createOverlayContentLine(width, layout, BORDER_FG, isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg);
        putText(labelLine, layout.margin + 2, INDICATOR_WIDTH, indicator, {
          fg: isSelected ? TITLE_FG : MUTED_FG,
          bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
          bold: isSelected,
        });
      putText(labelLine, layout.margin + 2 + INDICATOR_WIDTH, labelWidth, fitDisplay(truncateDisplay(item.label, labelWidth), labelWidth), {
        fg: labelColor,
        bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
        bold: isSelected,
      });
      if (item.detail) {
        if (detailLayout.wrappedDetail === null) {
          // Fits beside the label at a readable width, no truncation needed.
          putText(labelLine, layout.margin + 2 + INDICATOR_WIDTH + labelWidth, 2, '  ', {
            fg: BODY_FG,
            bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
          });
          putText(labelLine, layout.margin + 2 + INDICATOR_WIDTH + labelWidth + 2, detailLayout.detailWidth, fitDisplay(item.detail, detailLayout.detailWidth), {
            fg: detailColor,
            bg: isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg,
          });
          lines.push(labelLine);
        } else {
          // Doesn't fit beside the label, wrap the FULL detail text onto as
          // many lines as it needs below the label, rather than clipping it.
          lines.push(labelLine);
          for (const detailLineText of detailLayout.wrappedDetail) {
            const detailLine = createOverlayContentLine(width, layout, BORDER_FG, isSelected ? SELECTED_BG : DEFAULT_OVERLAY_PALETTE.bodyBg);
            putText(detailLine, layout.margin + 2 + INDICATOR_WIDTH, remaining, fitDisplay(detailLineText, remaining), {
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

    if (startIdx > 0 || endIdx < items.length) {
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
  // vocab unification: a caller-supplied primaryVerbLabel (e.g. /help's
  // "Run", matching the slash-command palette) wins over the generic
  // per-primaryAction default.
  const primaryVerb = modal.primaryVerbLabel
    ? `[Enter] ${modal.primaryVerbLabel}`
    : selectedItem?.primaryAction === 'toggle'
    ? '[Enter] Toggle'
    : selectedItem?.primaryAction === 'edit'
    ? '[Enter] Edit'
    : selectedItem?.primaryAction === 'delete'
    ? '[Enter] Delete'
    : '[Enter] Select';
  let hints = `[Up/Down] Navigate  ${primaryVerb}`;
  if (modal.allowSearch) hints += '  [/] Search';
  if (selectedItem?.primaryAction === 'toggle' && !selectedItem.actions) hints += '  [Space] Toggle';
  if (selectedItem?.actions) hints += `  ${selectedItem.actions}`;
  // hint-grammar: Esc is the conventional "way out" and always sorts last.
  hints += '  [Esc] Close';
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
