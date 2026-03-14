import { TerminalBuffer } from './buffer.ts';
import { DiffEngine } from './diff.ts';
import { type Line } from '../types/grid.ts';

export interface SelectionInfo {
  isCellSelected: (col: number, absoluteRow: number) => boolean;
  scrollTop: number;
  lineCount: number;
}

export interface CompositeRequest {
  width: number;
  height: number;
  header: Line[];
  viewport: Line[];
  footer: Line[];
  selection?: SelectionInfo;
}

/**
 * Compositor - Authoritative TUI layout engine with Selection Overlay.
 * Decoupled from global state — all needed data is passed as parameters.
 */
export class Compositor {
  private lastBuffer: TerminalBuffer | null = null;
  private diffEngine = new DiffEngine();

  constructor(private stdout: NodeJS.WriteStream) {}

  public resetDiff(): void {
    this.diffEngine.reset();
    this.lastBuffer = null;
  }

  public composite(params: CompositeRequest) {
    const { width, height, header, viewport, footer, selection } = params;
    const newBuffer = new TerminalBuffer(width, height);

    // 1. Draw Header (Rows 0-1)
    header.forEach((line, i) => newBuffer.blitLine(i, line));

    // 2. Draw Viewport (Starting at Row 2)
    const viewportStartY = 2;
    const vHeight = height - header.length - footer.length;

    // Calculate the offset for bottom-anchored short history
    const lineCount = selection?.lineCount ?? 0;
    const offset = Math.max(0, vHeight - lineCount);

    viewport.forEach((line, i) => {
      const screenY = viewportStartY + i;
      if (screenY >= height) return;
      newBuffer.blitLine(screenY, line);

      // Apply Selection Highlighting Overlay
      // Only highlight rows that actually contain history (past the bottom-anchor offset)
      if (selection && i >= offset) {
        const absoluteRow = selection.scrollTop + (i - offset);
        for (let x = 0; x < width; x++) {
          if (selection.isCellSelected(x, absoluteRow)) {
            newBuffer.setCell(x, screenY, { bg: '4', fg: '0', bold: false, dim: false });
          }
        }
      }
    });

    // 3. Draw Footer (Pinned to Bottom)
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
