import { type Line, type Cell, createEmptyLine } from '../types/grid.ts';
import type { Panel } from '../panels/types.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

// ---------------------------------------------------------------------------
// Color constants (vaporwave palette)
// ---------------------------------------------------------------------------
const ACTIVE_FG = '#00ffff';
const ACTIVE_BG = '#1a2a3a';
const INACTIVE_FG = '244';
const SEPARATOR_FG = '238';
const CLOSE_FG = '238';

/** A tab's rendered text and display width. */
interface TabInfo {
  text: string;   // e.g. " 💻 Files "
  width: number;  // display columns
}

/** Build the rendered text for a single tab. */
function buildTabText(panel: Panel): TabInfo {
  const text = ` ${panel.icon} ${panel.name} `;
  return { text, width: getDisplayWidth(text) };
}

/**
 * Write a string into a Line starting at column `startCol`.
 * Applies the given style to each cell. Returns the column after the last written char.
 */
function writeString(
  line: Line,
  text: string,
  startCol: number,
  width: number,
  style: Partial<Omit<Cell, 'char'>>,
): number {
  let col = startCol;
  for (const char of text) {
    if (col >= width) break;
    const cw = getDisplayWidth(char);
    const cell: Cell = {
      char,
      fg: style.fg ?? '',
      bg: style.bg ?? '',
      bold: style.bold ?? false,
      dim: style.dim ?? false,
      underline: style.underline ?? false,
      italic: style.italic ?? false,
      strikethrough: style.strikethrough ?? false,
    };
    line[col] = cell;
    if (cw === 2 && col + 1 < width) {
      line[col + 1] = { ...cell, char: '' };
    }
    col += cw;
  }
  return col;
}

/**
 * Render the panel tab bar.
 *
 * Shows open panel tabs with the active one highlighted.
 * Format: │ icon Name │ icon Name │ ...
 *
 * Active tab:   cyan (#00ffff), bold, bg #1a2a3a
 * Inactive tab: grey (244), no background
 * Separators:   │ in dim grey (238)
 * Overflow:     ▶ right scroll indicator (stateless — shows when tabs extend beyond width)
 * Close button: ✕ at far right for active tab
 */
export function renderPanelTabBar(
  panels: Panel[],
  activeIndex: number,
  width: number,
): Line {
  const line = createEmptyLine(width);

  if (panels.length === 0) {
    return line;
  }

  // Build tab info for all panels
  const tabs: TabInfo[] = panels.map(buildTabText);

  // Close button: " ✕ " reserved at far right
  const closeText = ' ✕ ';
  const closeW = getDisplayWidth(closeText);

  // Calculate total width needed: separator(1) + tab + separator(1) + ... + close
  // Layout: │tab0│tab1│tab2│ ... │ ✕
  // Each tab is preceded by │ separator, and followed by nothing (next │ is next tab's prefix)
  // Final layout: │<tab0>│<tab1>│...│<tabN>│ ✕
  // So total = (1 + tabW) * N + 1 (trailing sep) + closeW
  const tabsNaturalWidth = tabs.reduce((sum, t) => sum + 1 + t.width, 0) + 1 + closeW;

  const hasOverflow = tabsNaturalWidth > width;
  // Reserve column for right scroll indicator when overflowing (no left arrow)
  const rightIndicatorW = hasOverflow ? 1 : 0;
  // Usable area: full width minus right indicator and close button
  const usableWidth = width - rightIndicatorW - closeW;

  let col = 0;

  // Render tabs
  let tabsRendered = 0;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const isActive = i === activeIndex;
    // Width of this tab entry: │ + tab content
    const entryW = 1 + tab.width;

    // Check if the leading separator fits in usable area
    if (col + entryW > usableWidth) {
      // No more room — stop (right indicator will show overflow)
      break;
    }

    // Write leading separator │
    writeString(line, '\u2502', col, width, { fg: SEPARATOR_FG });
    col += 1;

    // Write tab content
    if (isActive) {
      writeString(line, tab.text, col, width, {
        fg: ACTIVE_FG,
        bg: ACTIVE_BG,
        bold: true,
      });
    } else {
      writeString(line, tab.text, col, width, {
        fg: INACTIVE_FG,
      });
    }
    col += tab.width;
    tabsRendered++;
  }

  // Trailing separator after last tab
  if (tabsRendered > 0 && col < usableWidth) {
    writeString(line, '\u2502', col, width, { fg: SEPARATOR_FG });
    col += 1;
  }

  // Fill gap between last tab (+ trailing sep) and right indicator with separator-colored spaces
  const gapEnd = width - closeW - rightIndicatorW;
  while (col < gapEnd) {
    writeString(line, ' ', col, width, { fg: SEPARATOR_FG });
    col += 1;
  }

  // Right scroll indicator
  if (hasOverflow) {
    const indicatorCol = width - closeW - 1;
    if (indicatorCol >= col) {
      writeString(line, '\u25b6', indicatorCol, width, { fg: SEPARATOR_FG });
    }
  }

  // Close button for active panel — always at the far right
  writeString(line, closeText, width - closeW, width, { fg: CLOSE_FG });

  return line;
}
