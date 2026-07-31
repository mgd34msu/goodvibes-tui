import { TerminalBuffer } from './buffer.ts';
import { DiffEngine } from './diff.ts';
import { type Line, createEmptyCell, createEmptyLine, createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { SearchManager } from '../input/search.ts';
import { allowTerminalWrite } from '@pellux/goodvibes-terminal-shell/terminal-output-guard';
import { probeTermCaps, type TermColorCaps } from './term-caps.ts';
import { activeTheme } from './theme.ts';
import { UI_TONES } from './ui-primitives.ts';

// Accent / dim colors for the panel focus border. The focused pane's left
// border column is drawn in the accent tone; the unfocused pane stays dim.
const PANEL_FOCUS_ACCENT = UI_TONES.state.active; // bright blue
const PANEL_BORDER_DIM = '238';

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
  /**
   * The single consolidated workspace tab bar spanning all open panels across
   * both panes. There are no per-pane tab bars — pane focus is shown by the
   * accent border (see `topFocused`/`bottomFocused`).
   */
  workspaceBar: Line;
  /** Top pane: panel content lines */
  topContent: Line[];
  /** Whether the top pane is focused (drives the accent border) */
  topFocused: boolean;
  /** Whether a bottom pane is present (splits the panel area). */
  hasBottomPane: boolean;
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
  /** Double-buffer reuse: back is written, front is the last-rendered reference. */
  private frontBuffer: TerminalBuffer | null = null;
  private backBuffer: TerminalBuffer | null = null;
  private readonly caps: TermColorCaps;
  private diffEngine: DiffEngine;
  /**
   * When true the next composite() repaints the WHOLE screen instead of
   * diffing against the last frame: erase display, then emit every cell.
   *
   * The incremental path is correct only while the front buffer still
   * describes what is physically on screen. Two things break that assumption:
   * a buffer reallocation (resize) makes the compositor forget the old frame,
   * and anything that writes to the terminal outside composite() moves content
   * the compositor never wrote. After either, a row the model believes is
   * already blank is never re-emitted, so whatever the terminal is showing
   * there — splash art, a stale rule line — survives every later frame. The
   * erase is what clears cells the diff structurally skips (wide-glyph
   * continuation cells, see DiffEngine.diff), which a diff against a null
   * front buffer alone cannot do.
   */
  private fullRepaintPending = false;

  constructor(private stdout: NodeJS.WriteStream) {
    // Probe terminal capabilities once at construction time.
    this.caps = probeTermCaps(stdout);
    this.diffEngine = new DiffEngine(this.caps);
  }

  /** Exposed for unit tests — returns the detected color capability. */
  public get termCapsForTest(): TermColorCaps {
    return this.caps;
  }

  /** Exposed for unit tests — returns the last composited buffer. */
  public get lastBufferForTest(): TerminalBuffer | null {
    return this.frontBuffer;
  }

  public resetDiff(): void {
    this.diffEngine.reset();
    this.frontBuffer = null;
    this.backBuffer = null;
    this.fullRepaintPending = true;
  }

  /**
   * Force the next frame to repaint the entire screen exactly once.
   *
   * Called at a state transition that replaces one full-screen composition
   * with another (the splash giving way to the transcript), where any cell the
   * incremental path leaves behind reads as corruption rather than as a stale
   * pixel. Unlike resetDiff() this keeps the buffers, so the frame after the
   * repaint resumes normal differential rendering.
   */
  public requestFullRepaint(): void {
    this.fullRepaintPending = true;
  }

  public composite(params: CompositeRequest): void {
    const { width, height, header, viewport, footer, selection, search, panel, panelWidth } = params;
    // A size change reallocates the buffer, which drops every record of what
    // the terminal is currently showing — repaint in full rather than diff
    // against a model that no longer describes the screen.
    const resized = this.frontBuffer !== null
      && (this.frontBuffer.width !== width || this.frontBuffer.height !== height);
    const fullRepaint = this.fullRepaintPending || resized;
    this.fullRepaintPending = false;
    // Reuse back-buffer instead of allocating each frame. A freshly allocated
    // back buffer is seeded from the front buffer for the same reason reset()
    // is: rows this frame does not write must keep describing what is on
    // screen, or the diff will skip them forever.
    if (!this.backBuffer) {
      this.backBuffer = new TerminalBuffer(width, height);
      if (!fullRepaint) this.backBuffer.reset(width, height, this.frontBuffer);
    } else {
      this.backBuffer.reset(width, height, fullRepaint ? null : this.frontBuffer);
    }
    const newBuffer = this.backBuffer;

    const hasPanel = panel !== undefined && panelWidth !== undefined && panelWidth > 0;
    const leftWidth = hasPanel ? Math.max(1, width - panelWidth - 1) : width;
    const sepX = hasPanel ? leftWidth : -1;

    // 1. Draw Header — always full width
    header.forEach((line, i) => newBuffer.blitLine(i, line));

    // 2. Draw Viewport directly after the supplied header.
    const viewportStartY = header.length;
    const vHeight = Math.max(0, height - header.length - footer.length);

    // Calculate the offset for bottom-anchored short history
    const lineCount = selection?.lineCount ?? 0;
    const offset = Math.max(0, vHeight - lineCount);

    // --- Pre-compute panel row layout when split pane is active ---
    // A single consolidated workspace bar heads the panel area; there are no
    // per-pane tab bars. When both panes are visible the layout is:
    //   row 0:              workspace tab bar
    //   rows 1..topH:       top content
    //   row topH+1:         horizontal separator (───)
    //   rows topH+2..end:   bottom content
    const hasBottomPane = hasPanel && panel!.hasBottomPane;
    let topPaneHeight = 0;   // number of content rows in top pane
    let hSepRow = -1;        // viewport row of the horizontal separator
    if (hasPanel && hasBottomPane) {
      const panelAreaRows = Math.max(0, vHeight - 1); // subtract workspace bar
      const contentRows = Math.max(0, panelAreaRows - 1); // subtract h-separator
      topPaneHeight = Math.max(1, Math.floor(contentRows * panel!.verticalSplitRatio));
      hSepRow = 1 + topPaneHeight; // workspace bar + top content rows
    }

    const panelFocused = hasPanel && (panel!.topFocused || panel!.bottomFocused);
    // Per-row left-border color: the focused pane's rows get the accent tone.
    const borderFgForRow = (i: number): string => {
      if (!hasPanel || !panel!.separator || !panelFocused) return PANEL_BORDER_DIM;
      if (!hasBottomPane) return panel!.topFocused ? PANEL_FOCUS_ACCENT : PANEL_BORDER_DIM;
      if (i === 0) return PANEL_FOCUS_ACCENT; // workspace bar — panel is focused
      if (i <= topPaneHeight) return panel!.topFocused ? PANEL_FOCUS_ACCENT : PANEL_BORDER_DIM;
      return panel!.bottomFocused ? PANEL_FOCUS_ACCENT : PANEL_BORDER_DIM;
    };

    // Every body row is written every frame, including rows the caller did not
    // supply a line for. A viewport array shorter than the body (a docked
    // overlay reserves a bottom inset, an overlay-row reservation overshoots
    // what actually rendered) used to leave those rows untouched: the buffer
    // then described them as blank while the terminal still showed the
    // previous composition there, and since a blank-over-blank blit is a no-op
    // no later frame ever repainted them. Supplying a blank line keeps the
    // model and the screen in agreement.
    const blankRow = createEmptyLine(width);
    const bodyRows = Math.max(viewport.length, vHeight);
    for (let i = 0; i < bodyRows; i++) {
      const line = viewport[i] ?? blankRow;
      const screenY = viewportStartY + i;
      if (screenY >= height) break;

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

        // Separator column (vertical bar between left and panel area).
        // Colored per-row so the focused pane shows a bright accent border.
        if (p.separator) {
          newBuffer.setCell(sepX, screenY, createStyledCell('│', { fg: borderFgForRow(i) }));
        }

        const panelStartX = sepX + 1;
        const clearPanelRemainder = (fromX = 0) => {
          for (let x = Math.max(0, fromX); x < panelWidth; x++) {
            newBuffer.setCell(panelStartX + x, screenY, createEmptyCell());
          }
        };
        const drawPanelLine = (panelLine: Line | undefined) => {
          if (panelLine === undefined) {
            clearPanelRemainder();
            return;
          }
          const limit = Math.min(panelLine.length, panelWidth);
          for (let x = 0; x < limit; x++) {
            const cell = panelLine[x];
            if (cell !== undefined) {
              newBuffer.setCell(panelStartX + x, screenY, cell);
            }
          }
          clearPanelRemainder(limit);
        };

        if (!hasBottomPane) {
          // --- Single pane mode ---
          // viewport row 0 → workspace bar, viewport rows 1+ → panel content
          const panelLine = i === 0 ? p.workspaceBar : p.topContent[i - 1];
          drawPanelLine(panelLine);
        } else {
          // --- Two pane mode (single consolidated workspace bar) ---
          // Row layout (by viewport row i):
          //   i = 0:                      workspace tab bar
          //   1 <= i <= topPaneHeight:    top content[i-1]
          //   i = hSepRow:                horizontal separator
          //   i >= hSepRow+1:             bottom content[i - (hSepRow+1)]
          let panelLine: Line | undefined;

          if (i === 0) {
            panelLine = p.workspaceBar;
          } else if (i <= topPaneHeight) {
            panelLine = p.topContent[i - 1];
          } else if (i === hSepRow) {
            // Horizontal separator between the two panes. Accent when the bottom
            // pane has focus so the divider reinforces the focus border.
            const focusFg = p.bottomFocused ? PANEL_FOCUS_ACCENT : PANEL_BORDER_DIM;
            for (let x = 0; x < panelWidth; x++) {
              newBuffer.setCell(panelStartX + x, screenY, createStyledCell('─', { fg: focusFg }));
            }
            // T-junction (├) joins the vertical left-border with the pane divider.
            if (p.separator) {
              newBuffer.setCell(sepX, screenY, createStyledCell('├', { fg: focusFg }));
            }
          } else {
            panelLine = p.bottomContent?.[i - (hSepRow + 1)];
          }

          if (i !== hSepRow) {
            drawPanelLine(panelLine);
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
        const T = activeTheme();
        const absoluteRow = search.scrollTop + (i - offset);
        const lineMatches = search.manager.getMatchesOnLine(absoluteRow);
        for (const match of lineMatches) {
          const isCurrent = search.manager.isCurrentMatch(absoluteRow, match.col);
          for (let x = match.col; x < match.col + match.length && x < leftWidth; x++) {
            if (isCurrent) {
              newBuffer.setCell(x, screenY, { bg: T.searchCurrentBg, fg: T.searchCurrentFg, bold: true, dim: false });
            } else {
              newBuffer.setCell(x, screenY, { bg: T.searchMatchBg, fg: T.searchMatchFg, bold: false, dim: false });
            }
          }
        }
      }
    }
    // (rows past the supplied viewport lines are covered by the loop above,
    // separator column included, so they can no longer keep a stale frame.)

    // 3. Draw Footer (Pinned to Bottom) — always full width
    const footerStart = height - footer.length;
    footer.forEach((line, i) => {
      const screenY = footerStart + i;
      if (screenY >= height) return;
      newBuffer.blitLine(screenY, line);
    });

    // 4. Diff and Render
    // Diff against front-buffer (last-rendered), then swap front/back — no clone() needed.
    // On a full repaint the SGR run-state is reset (the erase below leaves the
    // terminal's attributes unknown) and the diff runs against no previous
    // frame, so every cell of the grid is emitted.
    if (fullRepaint) this.diffEngine.reset();
    const diff = this.diffEngine.diff(fullRepaint ? null : this.frontBuffer, newBuffer);
    const payload = fullRepaint ? `\x1b[H\x1b[2J${diff}` : diff;
    if (payload) {
      allowTerminalWrite(() => this.stdout.write(payload));
    }

    // Swap: back (just written) becomes the new front reference; old front becomes the next back
    const swap = this.frontBuffer;
    this.frontBuffer = this.backBuffer;
    this.frontBuffer.clearDirty();
    this.backBuffer = swap;
  }
}
