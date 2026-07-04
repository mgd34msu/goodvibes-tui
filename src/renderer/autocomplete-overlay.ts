import { type Line } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
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
 */
export function renderAutocompleteOverlay(
  autocomplete: AutocompleteEngine,
  width: number,
  viewportHeight = 24,
): Line[] {
  const state = autocomplete.getState();
  if (!state.active || state.results.length === 0) return [];

  const lines: Line[] = [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 2,
    maxWidth: 88,
    chromeRows: 4,
    minContentRows: 6,
    maxContentRows: 10,
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
  const maxVisible = metrics.contentRows;
  let startIdx = 0;
  if (total > maxVisible) {
    startIdx = Math.max(
      0,
      Math.min(
        state.selectedIndex - Math.floor(maxVisible / 2),
        total - maxVisible,
      ),
    );
  }
  const endIdx = Math.min(startIdx + maxVisible, total);

  // UX-C palette curation (item 4): on a bare '/' (query === ''), the results
  // list is "common tier" (score 2) followed by "alphabetical rest" (score
  // 1) — see CommandRegistry.fuzzyMatch. commonCount marks that boundary;
  // draw a one-row separator there when it falls inside the visible window,
  // consuming one of the maxVisible slots so the box height never changes.
  const hasCommonSeparator = state.query === '' && state.commonCount > 0 && state.commonCount < total;
  type DisplayRow = { type: 'item'; index: number } | { type: 'separator' };
  const displayRows: DisplayRow[] = [];
  for (let i = startIdx; i < endIdx && displayRows.length < maxVisible; i++) {
    if (hasCommonSeparator && i === state.commonCount) {
      displayRows.push({ type: 'separator' });
      if (displayRows.length >= maxVisible) break;
    }
    displayRows.push({ type: 'item', index: i });
  }

  const indicatorWidth = 2;
  const maxCommandWidth = Math.min(18, Math.max(10, Math.floor(layout.innerWidth * 0.28)));
  const gapWidth = 2;
  const descWidth = Math.max(0, layout.innerWidth - indicatorWidth - maxCommandWidth - gapWidth);

  for (const row of displayRows) {
    if (row.type === 'separator') {
      const sepLine = createOverlayContentLine(width, layout);
      putText(sepLine, layout.margin + 2, layout.innerWidth, '─'.repeat(layout.innerWidth), { fg: BORDER_FG, dim: true });
      lines.push(sepLine);
      continue;
    }
    const i = row.index;
    const { command } = results[i];
    const isSelected = i === state.selectedIndex;
    const line = createOverlayContentLine(width, layout, BORDER_FG, isSelected ? SELECTED_BG : '');
    const indicator = isSelected ? '▸ ' : '  ';
    const commandText = fitDisplay(
      truncateDisplay(`/${command.name}`, maxCommandWidth),
      maxCommandWidth,
    );
    const descriptionText = fitDisplay(
      truncateDisplay(command.description, descWidth),
      descWidth,
    );
    let x = layout.margin + 2;
    putText(line, x, indicatorWidth, indicator, {
      fg: isSelected ? TITLE_FG : MUTED_FG,
      bg: isSelected ? SELECTED_BG : '',
      bold: isSelected,
    });
    x += indicatorWidth;
    putText(line, x, maxCommandWidth, commandText, {
      fg: isSelected ? TITLE_FG : BODY_FG,
      bg: isSelected ? SELECTED_BG : '',
      bold: isSelected,
    });
    x += maxCommandWidth;
    putText(line, x, gapWidth, '  ', {
      fg: BODY_FG,
      bg: isSelected ? SELECTED_BG : '',
    });
    x += gapWidth;
    putText(line, x, descWidth, descriptionText, {
      fg: isSelected ? BODY_FG : MUTED_FG,
      bg: isSelected ? SELECTED_BG : '',
      bold: false,
    });
    lines.push(line);
  }

  if (total > maxVisible) {
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
  // UX-C vocab unification: "Run"/"Close" match the /help selection modal's
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
