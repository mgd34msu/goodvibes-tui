import { type Line } from '../types/grid.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import type { FilePickerModal } from '../input/file-picker.ts';
import {
  createOverlayBorderLine,
  createOverlayBoxLayout,
  createOverlayContentLine,
  DEFAULT_OVERLAY_PALETTE,
  putOverlayText,
} from './overlay-box.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';

/**
 * Render the file picker modal as Line[] for overlay in the viewport.
 * Shows a bordered box with fuzzy-matched file results.
 */
export function renderFilePickerOverlay(
  picker: FilePickerModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const lines: Line[] = [];
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 4,
    maxWidth: 70,
    minContentRows: 6,
    maxContentRows: 10,
  });
  const layout = createOverlayBoxLayout(width, metrics.margin, metrics.boxWidth);
  const contentW = layout.innerWidth;
  const borderFg = DEFAULT_OVERLAY_PALETTE.borderFg;
  const titleFg = DEFAULT_OVERLAY_PALETTE.titleFg;
  const bodyFg = DEFAULT_OVERLAY_PALETTE.bodyFg;
  const mutedFg = DEFAULT_OVERLAY_PALETTE.mutedFg;
  const selectedBg = DEFAULT_OVERLAY_PALETTE.selectedBg;

  // Title bar
  const titleLine = createOverlayBorderLine(width, layout, '┌', '─', '┐', titleFg);
  putOverlayText(titleLine, layout.margin + 2, layout.width - 4, 'Select File', { fg: titleFg, bold: true });
  lines.push(titleLine);

  // Search input
  const queryDisplay = picker.query || '';
  const searchLine = createOverlayContentLine(width, layout, borderFg);
  const searchPrefix = '@ ';
  const queryText = fitDisplay(`${queryDisplay}_`, Math.max(0, contentW - getDisplayWidth(searchPrefix)));
  putOverlayText(searchLine, layout.margin + 2, getDisplayWidth(searchPrefix), searchPrefix, { fg: bodyFg });
  putOverlayText(searchLine, layout.margin + 2 + getDisplayWidth(searchPrefix), contentW - getDisplayWidth(searchPrefix), queryText, { fg: bodyFg });
  lines.push(searchLine);

  // Separator
  lines.push(createOverlayBorderLine(width, layout, '├', '─', '┤', mutedFg));

  // Results
  if (picker.results.length === 0) {
    const noResults = createOverlayContentLine(width, layout, borderFg);
    putOverlayText(noResults, layout.margin + 2, contentW, fitDisplay('No matching files', contentW), { fg: '244', dim: true });
    lines.push(noResults);
  } else {
    const maxVisible = metrics.contentRows;
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
      const indicator = isSelected ? '> ' : '  ';
      const displayFile = getDisplayWidth(file) > contentW - 2
        ? truncateDisplay(file, contentW - 2)
        : file;
      const line = createOverlayContentLine(width, layout, borderFg, isSelected ? selectedBg : '');
      putOverlayText(
        line,
        layout.margin + 2,
        contentW,
        fitDisplay(indicator + fitDisplay(displayFile, contentW - 2), contentW),
        {
          fg: isSelected ? titleFg : file.endsWith('/') ? titleFg : bodyFg,
          bg: isSelected ? selectedBg : '',
          bold: isSelected,
        },
      );
      lines.push(line);
    }
  }

  // Bottom border with hints
  const hints = '[Up/Down] Navigate  [Enter] Select  [Esc] Cancel';
  const bottomLine = createOverlayBorderLine(width, layout, '└', '─', '┘', mutedFg);
  putOverlayText(bottomLine, layout.margin + 2, layout.width - 4, truncateDisplay(hints, layout.width - 4), { fg: mutedFg, dim: true });
  lines.push(bottomLine);

  return lines;
}
