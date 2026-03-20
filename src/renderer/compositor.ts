import { TerminalBuffer } from './buffer.ts';
import { DiffEngine } from './diff.ts';
import { type Line, createStyledCell } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { SearchManager } from '../input/search.ts';

export interface SelectionInfo {
  isCellSelected: (col: number, absoluteRow: number) => boolean;
  scrollTop: number;
  lineCount: number;
}

export interface SearchInfo {
  manager: SearchManager;
  scrollTop: number;
  viewportStartY: number;
}

export interface PanelCompositeData {
  /** Top pane: tab bar */
  topTabBar: Line;
  /** Top pane: panel content lines */
  topContent: Line[];
  /** Whether the top pane is focused (affects separator color) */
  topFocused: boolean;
  /** Bottom pane tab bar. Undefined = no bottom pane. */
  bottomTabBar?: Line;
  /** Bottom pane content lines. Undefined = no bottom pane. */
  bottomContent?: Line[];
  /** Whether the bottom pane is focused */
  bottomFocused?: boolean;
  /** Separator between left and right panel area */
  separator: boolean;
  /** Ratio of panel height for the top pane (0–1). Only used when bottom pane is present. */
  verticalSplitRatio: number;
}

export interface CompositeRequest {
  width: number;
  height: number;
  header: Line[];
  viewport: Line[];
  footer: Line[];
  selection?: SelectionInfo;
  search?: SearchInfo;
  panel?: PanelCompositeData;
  panelWidth?: number; // width of the right panel area (0 = no panel)
}

/**
 * Compositor - Authoritative TUI layout engine with Selection Overlay.
 * Decoupled from global state — all needed data is passed as parameters.
 */
export class Compositor {
  private lastBuffer: TerminalBuffer | null = null;
  private diffEngine = new DiffEngine();

  constructor(private stdout: NodeJS.WriteStream) {}

  /** Exposed for unit tests — returns the last composited buffer. */
  public get lastBufferForTest(): TerminalBuffer | null {
    return this.lastBuffer;
  }

  public resetDiff(): void {
    this.diffEngine.reset();
    this.lastBuffer = null;
  }

  public composite(params: CompositeRequest) {
    const { width, height, header, viewport, footer, selection, search, panel, panelWidth } = params;
    const newBuffer = new TerminalBuffer(width, height);

    const hasPanel = panel !== undefined && panelWidth !== undefined && panelWidth > 0;
    const leftWidth = hasPanel ? Math.max(1, width - panelWidth - 1) : width;
    const sepX = hasPanel ? leftWidth : -1;

    // 1. Draw Header (Rows 0-1) — always full width
    header.forEach((line, i) => newBuffer.blitLine(i, line));

    // 2. Draw Viewport (Starting at Row 2)
    const viewportStartY = 2;
    const vHeight = Math.max(0, height - header.length - footer.length);

    // Calculate the offset for bottom-anchored short history
    const lineCount = selection?.lineCount ?? 0;
    const offset = Math.max(0, vHeight - lineCount);

    // --- Pre-compute panel row layout when split pane is active ---
    // When both top and bottom panes are visible, the panel area is split:
    //   row 0:              top tab bar
    //   rows 1..topH:       top content
    //   row topH+1:         horizontal separator (───)
    //   row topH+2:         bottom tab bar
    //   rows topH+3..end:   bottom content
    const hasBottomPane = hasPanel && panel!.bottomTabBar !== undefined;
    let topPaneHeight = 0;   // number of content rows in top pane
    let bottomPaneHeight = 0;
    let hSepRow = -1;        // viewport row of the horizontal separator
    if (hasPanel && hasBottomPane) {
      const panelAreaRows = vHeight; // total rows available in panel area
      // top: 1 (tabbar) + topContent rows; bottom: 1 (sep) + 1 (tabbar) + bottomContent
      const contentRows = Math.max(0, panelAreaRows - 3); // subtract top-tabbar + h-sep + bottom-tabbar
      topPaneHeight = Math.max(1, Math.floor(contentRows * panel!.verticalSplitRatio));
      bottomPaneHeight = Math.max(1, contentRows - topPaneHeight);
      hSepRow = 1 + topPaneHeight; // viewport row index of horizontal separator
    }

    const sepFg = hasPanel && panel!.separator
      ? (panel!.topFocused || panel!.bottomFocused ? '244' : '238')
      : '238';

    viewport.forEach((line, i) => {
      const screenY = viewportStartY + i;
      if (screenY >= height) return;

      if (!hasPanel) {
        // No panel: existing fast path
        newBuffer.blitLine(screenY, line);
      } else {
        // Panel active: write cells individually to support split layout
        // Left side: viewport cells 0..leftWidth-1
        for (let x = 0; x < leftWidth; x++) {
          const cell = line[x];
          if (cell !== undefined) {
            // If this is a wide char (2-cell) at the last left-side column,
            // it would bleed into the separator column visually.
            // Replace with a space to keep the separator aligned.
            if (x === leftWidth - 1 && cell.char && cell.char.length > 0 && getDisplayWidth(cell.char) > 1) {
              newBuffer.setCell(x, screenY, { ...cell, char: ' ' });
              continue;
            }
            newBuffer.setCell(x, screenY, cell);
          }
        }

        const p = panel!;

        // Separator column (vertical bar between left and panel area)
        if (p.separator) {
          newBuffer.setCell(sepX, screenY, createStyledCell('\u2502', { fg: sepFg }));
        }

        const panelStartX = sepX + 1;

        if (!hasBottomPane) {
          // --- Single pane mode (original behavior) ---
          // viewport row 0 → tabBar, viewport rows 1+ → panel content
          const panelLine = i === 0 ? p.topTabBar : p.topContent[i - 1];
          if (panelLine !== undefined) {
            for (let x = 0; x < panelWidth; x++) {
              const cell = panelLine[x];
              if (cell !== undefined) {
                newBuffer.setCell(panelStartX + x, screenY, cell);
              }
            }
          }
        } else {
          // --- Two pane mode ---
          // Row layout (by viewport row i):
          //   i = 0:                      top tab bar
          //   1 <= i <= topPaneHeight:     top content[i-1]
          //   i = hSepRow:                horizontal separator
          //   i = hSepRow+1:              bottom tab bar
          //   i >= hSepRow+2:             bottom content[i - (hSepRow+2)]
          let panelLine: Line | undefined;

          if (i === 0) {
            panelLine = p.topTabBar;
          } else if (i <= topPaneHeight) {
            panelLine = p.topContent[i - 1];
          } else if (i === hSepRow) {
            // Horizontal separator between the two panes
            // Render ─ chars across the panel width
            const focusFg = p.bottomFocused ? '36' : '238'; // cyan if bottom pane focused
            for (let x = 0; x < panelWidth; x++) {
              newBuffer.setCell(panelStartX + x, screenY, createStyledCell('\u2500', { fg: focusFg }));
            }
            // Also update the separator column char to T-junction (├):
            // ├ connects the vertical left-separator with the horizontal pane divider,
            // forming a clean T-shaped joint at the split point.
            if (p.separator) {
              newBuffer.setCell(sepX, screenY, createStyledCell('\u251c', { fg: focusFg }));
            }
          } else if (i === hSepRow + 1) {
            panelLine = p.bottomTabBar;
          } else {
            panelLine = p.bottomContent?.[i - (hSepRow + 2)];
          }

          if (panelLine !== undefined) {
            for (let x = 0; x < panelWidth; x++) {
              const cell = panelLine[x];
              if (cell !== undefined) {
                newBuffer.setCell(panelStartX + x, screenY, cell);
              }
            }
          }
        }
      }

      // Apply Selection Highlighting Overlay (left side only)
      // Only highlight rows that actually contain history (past the bottom-anchor offset)
      if (selection && i >= offset) {
        const absoluteRow = selection.scrollTop + (i - offset);
        for (let x = 0; x < leftWidth; x++) {
          if (selection.isCellSelected(x, absoluteRow)) {
            newBuffer.setCell(x, screenY, { bg: '4', fg: '0', bold: false, dim: false });
          }
        }
      }

      // Apply Search Match Highlighting Overlay (left side only)
      if (search && search.manager.active && search.manager.query.length > 0 && i >= offset) {
        const absoluteRow = search.scrollTop + (i - offset);
        const lineMatches = search.manager.getMatchesOnLine(absoluteRow);
        for (const match of lineMatches) {
          const isCurrent = search.manager.isCurrentMatch(absoluteRow, match.col);
          for (let x = match.col; x < match.col + match.length && x < leftWidth; x++) {
            if (isCurrent) {
              newBuffer.setCell(x, screenY, { bg: '#ffff00', fg: '#000000', bold: true, dim: false });
            } else {
              newBuffer.setCell(x, screenY, { bg: '#806600', fg: '#ffffff', bold: false, dim: false });
            }
          }
        }
      }
    });

    // Draw separator on remaining viewport rows past content (when panel is active)
    if (hasPanel && panel!.separator) {
      for (let i = viewport.length; i < vHeight; i++) {
        const screenY = viewportStartY + i;
        if (screenY >= height) break;
        newBuffer.setCell(sepX, screenY, createStyledCell('\u2502', { fg: sepFg }));
      }
    }

    // 3. Draw Footer (Pinned to Bottom) — always full width
    const footerStart = height - footer.length;
    footer.forEach((line, i) => {
      const screenY = footerStart + i;
      if (screenY >= height) return;
      newBuffer.blitLine(screenY, line);
    });

    // 4. Diff and Render
    const diff = this.diffEngine.diff(this.lastBuffer, newBuffer);
    if (diff) {
      this.stdout.write(diff);
    }

    this.lastBuffer = newBuffer.clone();
  }
}
