import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { fitDisplay, getDisplayWidth } from '../utils/terminal-width.ts';
import type { HistorySearch } from '../input/input-history.ts';
import { createBottomBarLine, writeBottomBarText } from '@pellux/goodvibes-terminal-shell';
import { formatHints } from './hint-grammar.ts';

/**
 * Truncate `text` to at most `maxWidth` display columns, then pad with spaces
 * to exactly `maxWidth` columns. CJK/emoji wide characters count as 2 columns.
 */
function truncateToWidth(text: string, maxWidth: number): string {
  return fitDisplay(text, maxWidth, '');
}

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
  if (width <= 0) return [];

  const match = historySearch.currentMatch;
  const hasMatch = match !== null && historySearch.query.length > 0;
  const noMatch = historySearch.query.length > 0 && !hasMatch;

  const prefix = noMatch
    ? '(failed reverse-i-search)`'
    : '(reverse-i-search)`';
  const queryPart = historySearch.query + "': ";
  const matchText = hasMatch ? match?.entry ?? '' : '';

  // Build the display string
  const label = prefix + queryPart;
  const hints = formatHints([
    { key: 'Ctrl+R/↑', verb: 'Older' },
    { key: 'Ctrl+S/↓', verb: 'Newer' },
    { key: 'Enter', verb: 'Accept' },
    { key: 'Esc', verb: 'Cancel' },
  ]);
  const full = truncateToWidth(`${label}${matchText}  ${hints}`, width);

  const line = createBottomBarLine(width, { fg: '#000000', bg: '#00ffcc' });
  writeBottomBarText(line, 0, width, full, { fg: '#000000', bg: '#00ffcc' });

  // Highlight the matched region in the match text with dim styling
  if (hasMatch && match) {
    const labelW = getDisplayWidth(label);
    const matchStartCol = labelW + match.matchStart;
    const matchEndCol = matchStartCol + match.matchLength;
    const highlightWidth = Math.max(0, matchEndCol - matchStartCol);
    const matchedSlice = truncateToWidth(match.entry.slice(match.matchStart, match.matchStart + match.matchLength), highlightWidth);
    writeBottomBarText(line, matchStartCol, highlightWidth, matchedSlice, {
      fg: '#000000',
      bg: '#00ffcc',
      bold: true,
      underline: true,
    });
  }

  return [line];
}
