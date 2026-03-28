import { type Line, type Cell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { HistorySearch } from '../input/input-history.ts';

/**
 * Truncate `text` to at most `maxWidth` display columns, then pad with spaces
 * to exactly `maxWidth` columns. CJK/emoji wide characters count as 2 columns.
 */
function truncateToWidth(text: string, maxWidth: number): string {
  let usedWidth = 0;
  let result = '';
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const charLen = code > 0xFFFF ? 2 : 1;
    const charWidth = getDisplayWidth(text.slice(i, i + charLen));
    if (usedWidth + charWidth > maxWidth) break;
    result += text.slice(i, i + charLen);
    usedWidth += charWidth;
    i += charLen;
  }
  // Pad to exactly maxWidth columns with spaces
  return result + ' '.repeat(maxWidth - usedWidth);
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
  const full = truncateToWidth(label + matchText, width);

  // Render the whole line teal
  const line = UIFactory.stringToLine(full, width, { fg: '#000000', bg: '#00ffcc', bold: false });

  // Highlight the matched region in the match text with dim styling
  if (hasMatch && match) {
    const labelW = getDisplayWidth(label);
    const matchStartCol = labelW + match.matchStart;
    const matchEndCol = matchStartCol + match.matchLength;
    const highlightStyle: Cell = {
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
        line[col] = { ...highlightStyle, char: existing.char };
      }
    }
  }

  return [line];
}
