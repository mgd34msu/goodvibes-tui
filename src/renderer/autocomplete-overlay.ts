import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { wrapWithHangingIndent } from './text-layout.ts';
import type { AutocompleteEngine } from '../input/autocomplete.ts';
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
 * Render the slash command autocomplete dropdown as Line[] for overlay in the viewport.
 *
 * A row's description renders inline only when it genuinely fits beside the
 * command name; otherwise the FULL description wraps onto its own line(s)
 * below the command name, with no line cap — descriptive text is never
 * clipped (same fix as selection-modal-overlay.ts's modal rule). Item
 * visibility is row-budget aware (a wrapped description can cost more than
 * one physical row), always showing the selected item in full and falling
 * back to the existing position counter rather than losing text.
 */
export function renderAutocompleteOverlay(
  autocomplete: AutocompleteEngine,
  width: number,
  viewportHeight = 24,
): Line[] {
  const state = autocomplete.getState();
  if (!state.active || state.results.length === 0) return [];

  const lines: Line[] = [];
  const chromeRows = 4;
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 2,
    maxWidth: 88,
    chromeRows,
    minContentRows: 6,
    // Rows grow with wrapped descriptions (never clipped) rather than
    // staying pinned at a small constant — still bounded by the viewport.
    maxContentRows: Math.max(10, viewportHeight - chromeRows - 4),
  });
  const layout = createOverlayBoxLayout(width, metrics.margin, metrics.boxWidth);

  lines.push(createOverlayBorderLine(width, layout, '┌', '─', '┐', BORDER_FG));

  const titleLine = createOverlayContentLine(width, layout);
  const titleText = ' Commands';
  const queryText = state.query ? `/${state.query}` : '/';
  const queryWidth = Math.min(Math.floor(layout.innerWidth / 2), Math.max(8, layout.innerWidth - getDisplayWidth(titleText) - 2));
  const leftText = fitDisplay(titleText, Math.max(0, layout.innerWidth - queryWidth));
  const rightText = truncateDisplay(queryText, queryWidth);
  putText(titleLine, layout.margin + 2, layout.innerWidth - queryWidth, leftText, { fg: TITLE_FG, bold: true });
  putText(
    titleLine,
    layout.margin + 2 + layout.innerWidth - queryWidth,
    queryWidth,
    fitDisplay(rightText, queryWidth),
    { fg: TITLE_FG, dim: true },
  );
  lines.push(titleLine);

  const results = state.results;
  const total = results.length;
  const rowBudget = Math.max(1, metrics.contentRows);

  const indicatorWidth = 2;
  const maxCommandWidth = Math.min(18, Math.max(10, Math.floor(layout.innerWidth * 0.28)));
  const gapWidth = 2;
  const descWidth = Math.max(0, layout.innerWidth - indicatorWidth - maxCommandWidth - gapWidth);
  const wrapWidth = Math.max(8, layout.innerWidth - indicatorWidth);

  // palette curation (item 4): on a bare '/' (query === ''), the results
  // list is "common tier" (score 2) followed by "alphabetical rest" (score
  // 1) — see CommandRegistry.fuzzyMatch. commonCount marks that boundary;
  // a one-row separator draws there when it falls inside the visible window.
  const hasCommonSeparator = state.query === '' && state.commonCount > 0 && state.commonCount < total;

  function descriptionFitsInline(description: string): boolean {
    return descWidth >= 12 && getDisplayWidth(description) <= descWidth;
  }

  /** Physical rows a result occupies: 1 for the command-name row, plus one more per wrapped description line when it doesn't fit inline, plus 1 more when the common/rest separator sits immediately before it. */
  function rowCostFor(index: number): number {
    const { command } = results[index];
    const rows = descriptionFitsInline(command.description)
      ? 1
      : 1 + wrapWithHangingIndent(command.description, wrapWidth, '').length;
    const separatorCost = hasCommonSeparator && index === state.commonCount ? 1 : 0;
    return rows + separatorCost;
  }

  // Row-budget-aware windowing (mirrors selection-modal-overlay.ts's fix): a
  // window of results is chosen by their REAL rendered height rather than
  // assuming one row per item, always including the selected item in full,
  // growing outward (roughly centered) until the budget is spent.
  const selectedIdx = Math.max(0, Math.min(state.selectedIndex, total - 1));
  let startIdx = selectedIdx;
  let endIdx = selectedIdx + 1;
  let usedRows = rowCostFor(selectedIdx);
  let growBefore = true;
  while (startIdx > 0 || endIdx < total) {
    const canGrowBefore = growBefore && startIdx > 0;
    const canGrowAfter = !growBefore && endIdx < total;
    if (canGrowBefore) {
      const cost = rowCostFor(startIdx - 1);
      if (usedRows + cost > rowBudget) break;
      startIdx -= 1;
      usedRows += cost;
    } else if (canGrowAfter) {
      const cost = rowCostFor(endIdx);
      if (usedRows + cost > rowBudget) break;
      endIdx += 1;
      usedRows += cost;
    } else if (startIdx > 0) {
      const cost = rowCostFor(startIdx - 1);
      if (usedRows + cost > rowBudget) break;
      startIdx -= 1;
      usedRows += cost;
    } else if (endIdx < total) {
      const cost = rowCostFor(endIdx);
      if (usedRows + cost > rowBudget) break;
      endIdx += 1;
      usedRows += cost;
    } else {
      break;
    }
    growBefore = !growBefore;
  }

  for (let i = startIdx; i < endIdx; i++) {
    if (hasCommonSeparator && i === state.commonCount) {
      const sepLine = createOverlayContentLine(width, layout);
      putText(sepLine, layout.margin + 2, layout.innerWidth, '─'.repeat(layout.innerWidth), { fg: BORDER_FG, dim: true });
      lines.push(sepLine);
    }

    const { command } = results[i];
    const isSelected = i === state.selectedIndex;
    const bg = isSelected ? SELECTED_BG : '';
    const indicator = isSelected ? '▸ ' : '  ';
    const commandText = fitDisplay(
      truncateDisplay(`/${command.name}`, maxCommandWidth),
      maxCommandWidth,
    );

    const line = createOverlayContentLine(width, layout, BORDER_FG, bg);
    let x = layout.margin + 2;
    putText(line, x, indicatorWidth, indicator, {
      fg: isSelected ? TITLE_FG : MUTED_FG,
      bg,
      bold: isSelected,
    });
    x += indicatorWidth;
    putText(line, x, maxCommandWidth, commandText, {
      fg: isSelected ? TITLE_FG : BODY_FG,
      bg,
      bold: isSelected,
    });
    x += maxCommandWidth;

    if (descriptionFitsInline(command.description)) {
      putText(line, x, gapWidth, '  ', { fg: BODY_FG, bg });
      x += gapWidth;
      putText(line, x, descWidth, fitDisplay(command.description, descWidth), {
        fg: isSelected ? BODY_FG : MUTED_FG,
        bg,
        bold: false,
      });
      lines.push(line);
    } else {
      // Doesn't fit beside the command name — wrap the FULL description onto
      // its own line(s) below at the full row width, rather than clipping it.
      lines.push(line);
      for (const wrapped of wrapWithHangingIndent(command.description, wrapWidth, '')) {
        const descLine = createOverlayContentLine(width, layout, BORDER_FG, bg);
        putText(descLine, layout.margin + 2 + indicatorWidth, wrapWidth, fitDisplay(wrapped, wrapWidth), {
          fg: isSelected ? BODY_FG : MUTED_FG,
          bg,
        });
        lines.push(descLine);
      }
    }
  }

  if (startIdx > 0 || endIdx < total) {
    const scrollLine = createOverlayContentLine(width, layout);
    const scrollText = `${state.selectedIndex + 1}/${total}`;
    putText(
      scrollLine,
      layout.margin + 2 + Math.max(0, layout.innerWidth - getDisplayWidth(scrollText)),
      getDisplayWidth(scrollText),
      scrollText,
      { fg: MUTED_FG, dim: true },
    );
    lines.push(scrollLine);
  }

  const footerLine = createOverlayContentLine(width, layout);
  // vocab unification: "Run"/"Close" match the /help selection modal's
  // hint bar (selection-modal-overlay.ts) — both surfaces execute a command
  // on Enter, so they now say so the same way.
  const hints = '[Tab] Complete  [Up/Down] Navigate  [Enter] Run  [Esc] Close';
  putText(
    footerLine,
    layout.margin + 2,
    layout.innerWidth,
    fitDisplay(truncateDisplay(hints, layout.innerWidth), layout.innerWidth),
    { fg: MUTED_FG, dim: true },
  );
  lines.push(footerLine);

  lines.push(createOverlayBorderLine(width, layout, '└', '─', '┘', BORDER_FG));
  return lines;
}
