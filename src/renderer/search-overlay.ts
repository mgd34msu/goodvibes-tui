import { type Line, type Cell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { SearchManager } from '../input/search.ts';

/**
 * Render the search bar as a single Line[] overlay at the bottom of the viewport.
 * Format: [ Find: <query>   3/17 ▲▼  [n] next [N] prev [Esc] close ]
 * The match count is dim grey; the rest of the bar is teal.
 */
export function renderSearchOverlay(
  manager: SearchManager,
  width: number
): Line[] {
  // Match count text — displayed in dim grey, right of query, left of hints
  const matchCount = manager.matches?.length > 0
    ? `${manager.currentMatch + 1}/${manager.matches.length} \u25b2\u25bc`
    : manager.query.length > 0
      ? 'No matches'
      : '';

  const locked = manager.locked;
  const cursor = locked ? '' : '\u2588'; // block cursor only when typing
  const queryDisplay = manager.query + cursor;
  const hints = locked
    ? '  [\u2191\u2193] or [jk] navigate  [Bksp] edit  [Esc] close'
    : '  [Enter/Tab] lock  [Esc] close';
  const label = ' Find: ';
  const matchStr = matchCount ? ` ${matchCount}` : '';

  // Build left portion: label + query (no match count — that gets separate styling)
  const leftPart = label + queryDisplay;
  const hintsW = getDisplayWidth(hints);
  const matchStrW = getDisplayWidth(matchStr);
  // Available width for left content (query area)
  const leftWidth = width - hintsW - matchStrW - 2;
  const truncatedLeft = getDisplayWidth(leftPart) > leftWidth
    ? leftPart.slice(0, leftWidth - 1) + '\u2026'
    : leftPart.padEnd(leftWidth);

  // Build the full line text (match count embedded for positional tracking)
  const fullLine = (truncatedLeft + matchStr + hints + ' ').slice(0, width);

  // Render entire line with teal styling first
  const line = UIFactory.stringToLine(fullLine, width, { fg: '#000000', bg: '#00ffcc', bold: false });

  // Overwrite match count segment with dim grey styling
  if (matchStr.length > 0) {
    const matchStart = getDisplayWidth(truncatedLeft);
    const matchEnd = matchStart + matchStrW;
    const dimStyle: Cell = {
      char: ' ',
      fg: '#888888',
      bg: '#00ffcc',
      bold: false,
      dim: true,
      underline: false,
      italic: false,
      strikethrough: false,
    };
    for (let col = matchStart; col < matchEnd && col < width; col++) {
      const existing = line[col];
      if (existing) {
        line[col] = { ...dimStyle, char: existing.char };
      }
    }
  }

  return [line];
}
