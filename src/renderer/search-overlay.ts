import type { Line } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { SearchManager } from '../input/search.ts';
import { createBottomBarLine, writeBottomBarText } from './bottom-bar.ts';

/**
 * Render the search bar as a single Line[] overlay at the bottom of the viewport.
 * Format: [ Find: <query>   3/17  [n/N] next/prev  [Esc] close ]
 * The match count is dim grey; the rest of the bar is teal.
 *
 * Case-insensitive search (query lowercased before matching rendered cell text).
 */
export function renderSearchOverlay(
  manager: SearchManager,
  width: number
): Line[] {
  // Match count / status text — displayed in dim grey, right of query
  const hasMatches = manager.matches.length > 0;
  const matchCount = hasMatches
    ? `${manager.currentMatch + 1}/${manager.matches.length}${manager.wrapAround ? ' (wrap)' : ''}`
    : manager.query.length > 0
      ? 'No matches'
      : '';

  const locked = manager.locked;
  const cursor = locked ? '' : '█';
  const queryDisplay = manager.query + cursor;
  const label = ' Find: ';
  const fullHints = locked
    ? '  [n/N] next/prev  [jk] navigate  [Bksp] edit  [Esc] close'
    : '  [Enter/Tab] lock  [Esc] close';
  const shortHints = locked ? '  [n/N]  [Esc]' : '  [Esc]';

  // Build left portion: label + query (no match count — that gets separate styling)
  const leftPart = label + queryDisplay;

  // Tiered degradation: as the terminal narrows, first shorten the hints, then
  // drop them, then drop the match-count segment — so the query area (leftWidth)
  // never collapses to zero or negative and the overlay never renders garbage.
  const minLeft = getDisplayWidth(label) + 4; // label + a few query cells
  let hints = fullHints;
  let matchStr = matchCount ? ` ${matchCount}` : '';
  const leftFor = (h: string, m: string) => width - getDisplayWidth(h) - getDisplayWidth(m) - 2;
  let leftWidth = leftFor(hints, matchStr);
  if (leftWidth < minLeft) {
    hints = shortHints;
    leftWidth = leftFor(hints, matchStr);
  }
  if (leftWidth < minLeft) {
    hints = '';
    leftWidth = leftFor(hints, matchStr);
  }
  if (leftWidth < minLeft && matchStr.length > 0) {
    matchStr = '';
    leftWidth = leftFor(hints, matchStr);
  }
  // Final clamp: at least one cell, never wider than the bar.
  leftWidth = Math.max(1, Math.min(width, leftWidth));

  const matchStrW = getDisplayWidth(matchStr);
  const truncatedLeft = fitDisplay(
    getDisplayWidth(leftPart) > leftWidth ? truncateDisplay(leftPart, leftWidth) : leftPart,
    leftWidth,
  );

  // Build the full line text (match count embedded for positional tracking)
  const fullLine = truncatedLeft + matchStr + hints + ' ';
  const line = createBottomBarLine(width, { fg: '#000000', bg: '#00ffcc' });
  writeBottomBarText(line, 0, width, fitDisplay(truncateDisplay(fullLine, width), width), { fg: '#000000', bg: '#00ffcc' });

  // Overwrite match count segment with dim grey styling
  if (matchStr.length > 0) {
    const matchStart = getDisplayWidth(truncatedLeft);
    writeBottomBarText(line, matchStart, matchStrW, matchStr, { fg: '#888888', bg: '#00ffcc', dim: true });
  }

  return [line];
}
