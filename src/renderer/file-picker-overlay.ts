import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { FilePickerModal } from '../input/file-picker.ts';

/**
 * Render the file picker modal as Line[] for overlay in the viewport.
 * Shows a bordered box with fuzzy-matched file results.
 */
export function renderFilePickerOverlay(
  picker: FilePickerModal,
  width: number
): Line[] {
  const lines: Line[] = [];
  const boxMargin = 4;
  const boxW = Math.max(4, Math.min(width - boxMargin * 2, 70));
  const contentW = boxW - 4;
  const pad = ' '.repeat(boxMargin);

  // Title bar
  const queryDisplay = picker.query || '';
  const title = ` @ ${queryDisplay}`;
  const titleLine = pad + '\u250c' + '\u2500 Select File ' + '\u2500'.repeat(Math.max(0, boxW - 16)) + '\u2510';
  lines.push(UIFactory.stringToLine(titleLine, width, { fg: '#00ffff' }));

  // Search input
  const searchLine = pad + '\u2502 @ ' + queryDisplay + '\u2588' + ' '.repeat(Math.max(0, contentW - getDisplayWidth(queryDisplay) - 3)) + '\u2502';
  lines.push(UIFactory.stringToLine(searchLine, width, { fg: '252' }));

  // Separator
  const sepLine = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
  lines.push(UIFactory.stringToLine(sepLine, width, { fg: '240' }));

  // Results
  if (picker.results.length === 0) {
    const noResults = pad + '\u2502 ' + 'No matching files'.padEnd(contentW) + ' \u2502';
    lines.push(UIFactory.stringToLine(noResults, width, { fg: '244', dim: true }));
  } else {
    const maxVisible = 12;
    let startIdx = 0;
    if (picker.results.length > maxVisible) {
      startIdx = Math.max(0, Math.min(
        picker.selectedIndex - Math.floor(maxVisible / 2),
        picker.results.length - maxVisible,
      ));
    }
    const endIdx = Math.min(startIdx + maxVisible, picker.results.length);

    for (let i = startIdx; i < endIdx; i++) {
      const file = picker.results[i];
      const isSelected = i === picker.selectedIndex;
      const indicator = isSelected ? '\u25b6 ' : '  ';
      const displayFile = file.length > contentW - 4
        ? '\u2026' + file.slice(-(contentW - 5))
        : file;
      const line = pad + '\u2502 ' + indicator + displayFile.padEnd(contentW - 2) + '\u2502';
      lines.push(UIFactory.stringToLine(line, width, {
        fg: isSelected ? '#00ffff' : file.endsWith('/') ? '#00ffff' : '252',
        bold: isSelected,
        bg: isSelected ? '#1a2a3a' : '',
      }));
    }
  }

  // Bottom border with hints
  const hints = ' [\u2191\u2193] Navigate  [Enter] Select  [Esc] Cancel ';
  const bottomLine = pad + '\u2514' + hints + '\u2500'.repeat(Math.max(0, boxW - 2 - getDisplayWidth(hints))) + '\u2518';
  lines.push(UIFactory.stringToLine(bottomLine, width, { fg: '240' }));

  // Trailing empty line — ensures 1 row gap between modal bottom and input area
  lines.push(UIFactory.stringToLine('', width));

  return lines;
}
