import { TerminalBuffer } from './buffer.ts';
import { DiffEngine } from './diff.ts';
import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import type { SearchManager } from '../input/search.ts';
import { allowTerminalWrite } from '@pellux/goodvibes-terminal-shell/terminal-output-guard';
import { probeTermCaps, type TermColorCaps } from './term-caps.ts';
import { activeTheme, activeTokens } from './theme.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { composeLayers } from './surface-compose.ts';

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

export interface CompositeRequest {
  width: number;
  height: number;
  header: Line[];
  viewport: Line[];
  footer: Line[];
  selection?: SelectionInfo;
  search?: SearchInfo;
  /**
   * Surfaces stamped over the finished screen, in order: modals (which dim
   * everything underneath first), toasts. Screen coordinates.
   */
  layers?: readonly SurfaceLayer[];
}

/**
 * Compositor - Authoritative TUI layout engine with Selection Overlay.
 * Decoupled from global state, all needed data is passed as parameters.
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
   * there, splash art, a stale rule line, survives every later frame. The
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

  /** Exposed for unit tests, returns the detected color capability. */
  public get termCapsForTest(): TermColorCaps {
    return this.caps;
  }

  /** Exposed for unit tests, returns the last composited buffer. */
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
    const { width, height, header, viewport, footer, selection, search, layers } = params;
    // A size change reallocates the buffer, which drops every record of what
    // the terminal is currently showing, repaint in full rather than diff
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

    // 1. Draw Header, always full width
    header.forEach((line, i) => newBuffer.blitLine(i, line));

    // 2. Draw Viewport directly after the supplied header.
    const viewportStartY = header.length;
    const vHeight = Math.max(0, height - header.length - footer.length);

    // Calculate the offset for bottom-anchored short history
    const lineCount = selection?.lineCount ?? 0;
    const offset = Math.max(0, vHeight - lineCount);

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

      newBuffer.blitLine(screenY, line);

      // Apply Selection Highlighting Overlay
      // Only highlight rows that actually contain history (past the bottom-anchor offset)
      if (selection && i >= offset) {
        const absoluteRow = selection.scrollTop + (i - offset);
        for (let x = 0; x < width; x++) {
          if (selection.isCellSelected(x, absoluteRow)) {
            // Mouse selection: the theme's selection fill with body text (the
            // inverse selectedListItemText is unreadable on this fill).
            const sel = activeTokens();
            newBuffer.setCell(x, screenY, { bg: sel.backgroundSelected, fg: sel.text, bold: false, dim: false });
          }
        }
      }

      // Apply Search Match Highlighting Overlay
      if (search && search.manager.active && search.manager.query.length > 0 && i >= offset) {
        const T = activeTheme();
        const absoluteRow = search.scrollTop + (i - offset);
        const lineMatches = search.manager.getMatchesOnLine(absoluteRow);
        for (const match of lineMatches) {
          const isCurrent = search.manager.isCurrentMatch(absoluteRow, match.col);
          for (let x = match.col; x < match.col + match.length && x < width; x++) {
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
    // so they can no longer keep a stale frame.)

    // 3. Draw Footer (Pinned to Bottom), always full width
    const footerStart = height - footer.length;
    footer.forEach((line, i) => {
      const screenY = footerStart + i;
      if (screenY >= height) return;
      newBuffer.blitLine(screenY, line);
    });

    // 4. Modal passes: dim the composed screen, then stamp each surface over
    // it (cells outside a surface keep their dimmed content). Runs after the
    // selection and search passes so those dim along with everything else.
    if (layers && layers.length > 0) composeLayers(newBuffer, layers);

    // 5. Diff and Render
    // Diff against front-buffer (last-rendered), then swap front/back, no clone() needed.
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
