import { type Line, type Cell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { HistorySearch } from '../input/input-history.ts';

/**
 * Render the reverse-i-search bar as a single Line[] overlay at the bottom of the viewport.
 * Format: (reverse-i-search)`query': matched-command-text
 *
 * - The matched command text is shown in dim grey over the teal bar.
 * - If no match, shows "(failed reverse-i-search)" prefix.
 */
export function renderHistorySearchOverlay(
  historySearch: HistorySearch,
  width: number
): Line[] {
  const match = historySearch.currentMatch;
  const hasMatch = match !== null && historySearch.query.length > 0;
  const noMatch = historySearch.query.length > 0 && !hasMatch;

  const prefix = noMatch
    ? '(failed reverse-i-search)`'
    : '(reverse-i-search)`';
  const queryPart = historySearch.query + "': ";
  const matchText = hasMatch ? match!.entry : '';

  // Build the display string
  const label = prefix + queryPart;
  const full = (label + matchText).slice(0, width).padEnd(width);

  // Render the whole line teal
  const line = UIFactory.stringToLine(full, width, { fg: '#000000', bg: '#00ffcc', bold: false });

  // Highlight the matched region in the match text with dim styling
  if (hasMatch && match) {
    const labelW = getDisplayWidth(label);
    const matchStartCol = labelW + match.matchStart;
    const matchEndCol = matchStartCol + match.matchLength;
    const dimStyle: Cell = {
      char: ' ',
      fg: '#000000',
      bg: '#00ffcc',
      bold: true,
      dim: false,
      underline: true,
      italic: false,
      strikethrough: false,
    };
    for (let col = matchStartCol; col < matchEndCol && col < width; col++) {
      const existing = line[col];
      if (existing) {
        line[col] = { ...dimStyle, char: existing.char };
      }
    }
  }

  return [line];
}
