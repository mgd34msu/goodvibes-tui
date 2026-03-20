import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { AutocompleteEngine } from '../input/autocomplete.ts';

/** Maximum number of completions to show at once. */
const MAX_VISIBLE = 8;

/**
 * Render the slash command autocomplete dropdown as Line[] for overlay in the viewport.
 * Shows a bordered box with matching command names and descriptions.
 * The selected item is highlighted in cyan.
 */
export function renderAutocompleteOverlay(
  autocomplete: AutocompleteEngine,
  width: number,
): Line[] {
  const state = autocomplete.getState();
  if (!state.active || state.results.length === 0) return [];

  const lines: Line[] = [];
  // boxMargin is intentionally 2 (not 4 like other overlays) so the autocomplete
  // docks close to the input rather than indenting deeply into the viewport.
  const boxMargin = 2;
  const boxW = Math.max(20, Math.min(width - boxMargin * 2, 88));
  const contentW = boxW - 4; // 2 border chars + 2 padding chars each side
  const pad = ' '.repeat(boxMargin);

  // ── Title bar ──────────────────────────────────────────────────────────────
  const titleText = '\u2500 Commands ';
  const queryDisplay = state.query ? `/${state.query}` : '/';
  const queryHint = ` ${queryDisplay} `;
  const availForQuery = Math.max(0, boxW - 2 - getDisplayWidth(titleText));
  const truncatedHint = getDisplayWidth(queryHint) > availForQuery
    ? queryHint.slice(0, availForQuery - 1) + '\u2026'
    : queryHint;
  const rightW = Math.max(0, boxW - 2 - getDisplayWidth(titleText) - getDisplayWidth(truncatedHint));
  const titleLine =
    pad + '\u250c' + titleText + '\u2500'.repeat(rightW) + truncatedHint.trimEnd() + '\u2510';
  lines.push(UIFactory.stringToLine(titleLine, width, { fg: '#00ffff' }));

  // ── Command list ───────────────────────────────────────────────────────────
  const results = state.results;
  const total = results.length;

  // Compute scroll window so selected item is always visible
  let startIdx = 0;
  if (total > MAX_VISIBLE) {
    startIdx = Math.max(
      0,
      Math.min(
        state.selectedIndex - Math.floor(MAX_VISIBLE / 2),
        total - MAX_VISIBLE,
      ),
    );
  }
  const endIdx = Math.min(startIdx + MAX_VISIBLE, total);

  for (let i = startIdx; i < endIdx; i++) {
    const { command } = results[i];
    const isSelected = i === state.selectedIndex;
    const indicator = isSelected ? '\u25b6 ' : '  ';

    // Left column: command name with leading '/' (max ~14 chars)
    const maxCmdLen = 14;
    const cmdRaw = '/' + command.name;
    const cmdStr = cmdRaw.length > maxCmdLen
      ? cmdRaw.slice(0, maxCmdLen - 1) + '\u2026'
      : cmdRaw.padEnd(maxCmdLen);

    // Right column: description (remaining space)
    const gap = 2;
    const descWidth = contentW - maxCmdLen - gap - 2; // 2 = indicator
    const descRaw = command.description;
    const descStr = descRaw.length > descWidth
      ? descRaw.slice(0, descWidth - 1) + '\u2026'
      : descRaw;
    const descPadded = descStr + ' '.repeat(Math.max(0, descWidth - getDisplayWidth(descStr)));

    const rowText = pad + '\u2502 ' + indicator + cmdStr + ' '.repeat(gap) + descPadded + ' \u2502';
    lines.push(UIFactory.stringToLine(rowText, width, {
      fg: isSelected ? '#00ffff' : '252',
      bold: isSelected,
      bg: isSelected ? '#1a2a3a' : '',
    }));
  }

  // ── Scroll indicator when list is truncated ───────────────────────────────
  if (total > MAX_VISIBLE) {
    const scrollInfo = `${state.selectedIndex + 1}/${total}`;
    const scrollLine = pad + '\u2502' + ' '.repeat(Math.max(0, boxW - 2 - getDisplayWidth(scrollInfo) - 1)) + scrollInfo + ' \u2502';
    lines.push(UIFactory.stringToLine(scrollLine, width, { fg: '240', dim: true }));
  }

  // ── Bottom border with hints ───────────────────────────────────────────────
  const hints = ' [Tab] Complete  [\u2191\u2193] Navigate  [Enter] Execute  [Esc] Cancel ';
  const hintW = getDisplayWidth(hints);
  const bottomLine =
    pad + '\u2514' + hints + '\u2500'.repeat(Math.max(0, boxW - 2 - hintW)) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  return lines;
}
