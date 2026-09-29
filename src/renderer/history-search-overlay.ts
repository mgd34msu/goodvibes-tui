import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { fitDisplay, getDisplayWidth } from '../utils/terminal-width.ts';
import type { HistorySearch } from '../input/input-history.ts';
import { createBottomBarLine, writeBottomBarText } from '@pellux/goodvibes-terminal-shell';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.ts';
import type { KitHint } from './surface-kit.ts';
import { activeTokens } from './theme.ts';

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
  const hints: KitHint[] = [['ctrl+r ↑', 'older'], ['ctrl+s ↓', 'newer'], ['⏎', 'accept'], ['esc', 'cancel']];
  // Keycap hints sit at the right end of the bar when they fit beside the search.
  const hintsW = keycapHintsWidth(hints);
  const showHints = width - hintsW - 2 >= getDisplayWidth(label) + 8;
  const textW = showHints ? width - hintsW - 4 : width;
  const full = truncateToWidth(`${label}${matchText}`, textW);

  const p = activeTokens();
  const line = createBottomBarLine(width, { fg: p.selectedListItemText, bg: p.accent });
  writeBottomBarText(line, 0, textW, full, { fg: p.selectedListItemText, bg: p.accent });
  if (showHints) paintKeycapHints(line, width - hintsW - 2, width - 2, hints, { fg: p.selectedListItemText, bg: p.accent });

  // Highlight the matched region in the match text with dim styling
  if (hasMatch && match) {
    const labelW = getDisplayWidth(label);
    const matchStartCol = labelW + match.matchStart;
    const matchEndCol = matchStartCol + match.matchLength;
    const highlightWidth = Math.max(0, matchEndCol - matchStartCol);
    const matchedSlice = truncateToWidth(match.entry.slice(match.matchStart, match.matchStart + match.matchLength), highlightWidth);
    writeBottomBarText(line, matchStartCol, highlightWidth, matchedSlice, {
      fg: p.selectedListItemText,
      bg: p.accent,
      bold: true,
      underline: true,
    });
  }

  return [line];
}
