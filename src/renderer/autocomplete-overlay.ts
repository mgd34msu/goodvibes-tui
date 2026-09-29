/**
 * renderAutocompleteOverlay, the slash-command popup.
 *
 * Anchored to the composer with no dimming (you are still typing): the same
 * width as the composer, a ┃ bar on its left edge, the surface fill, and no
 * frame or hint rows. Command names line up in one column with their
 * descriptions beside them; a description that does not fit on its row is
 * left out rather than cut, and the selected row always shows its full
 * description (wrapped) with "tab complete" on the right. When the list is
 * longer than the popup, its last row carries a muted "12 more ↓" count.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { AutocompleteEngine } from '../input/autocomplete.ts';
import { activeTokens } from './theme.ts';
import { renderPopup, POPUP_BAR_X } from './surface-kit-parts.ts';
import type { KitRow } from './surface-kit-list.ts';

/** Rows the popup may use at most (it shrinks to its content). */
function popupRows(viewportHeight: number): number {
  return Math.max(3, Math.min(12, Math.floor(viewportHeight * 0.5)));
}

export function renderAutocompleteOverlay(
  autocomplete: AutocompleteEngine,
  width: number,
  viewportHeight = 24,
): Line[] {
  const state = autocomplete.getState();
  if (!state.active || state.results.length === 0) return [];
  const t = activeTokens();
  // Text columns inside the popup: fill starts right of the bar, text 2 in.
  const x0 = POPUP_BAR_X + 3;
  const x1 = width - 5;
  const nameW = Math.min(20, Math.max(...state.results.map((r) => getDisplayWidth(r.command.name) + 1)));
  const tabHint = 'tab complete';
  const rows: KitRow[] = state.results.map((result, index) => {
    const selected = index === state.selectedIndex;
    const name = `/${result.command.name}`;
    const pad = ' '.repeat(Math.max(2, nameW + 2 - getDisplayWidth(name)));
    const room = x1 - x0 + 1 - getDisplayWidth(name) - pad.length - (selected ? getDisplayWidth(tabHint) + 2 : 0);
    const description = result.command.description;
    const showDesc = selected || getDisplayWidth(description) <= room;
    return {
      spans: [
        { text: name, fg: t.text, bold: selected },
        ...(showDesc && description ? [{ text: `${pad}${description}`, fg: t.textMuted }] : []),
      ],
      right: selected ? tabHint : undefined,
      selected,
    };
  });
  return renderPopup({ width, rows, maxRows: popupRows(viewportHeight), scrollOwner: autocomplete }).lines;
}
