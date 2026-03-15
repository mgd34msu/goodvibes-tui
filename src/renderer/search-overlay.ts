import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { SearchManager } from '../input/search.ts';

/**
 * Render the search bar as a single Line[] overlay at the bottom of the viewport.
 * Format: [ Find: <query> [N/M matches] [n] next [N] prev [Esc] close ]
 */
export function renderSearchOverlay(
  manager: SearchManager,
  width: number
): Line[] {
  const matchInfo = manager.matches.length > 0
    ? `[${manager.currentMatch + 1}/${manager.matches.length}]`
    : manager.query.length > 0
      ? '[no matches]'
      : '';

  const cursor = '\u2588'; // block cursor
  const queryDisplay = manager.query + cursor;
  const hints = '  [n] next  [N] prev  [Esc] close';
  const label = ' Find: ';
  const matchStr = matchInfo ? ` ${matchInfo}` : '';

  const contentPart = label + queryDisplay + matchStr;
  const contentWidth = width - getDisplayWidth(hints) - 2;
  const truncated = getDisplayWidth(contentPart) > contentWidth
    ? contentPart.slice(0, contentWidth - 1) + '\u2026'
    : contentPart.padEnd(contentWidth);

  const fullLine = truncated + hints + ' ';

  return [UIFactory.stringToLine(fullLine.slice(0, width), width, { fg: '#000000', bg: '#00ffcc', bold: false })];
}
