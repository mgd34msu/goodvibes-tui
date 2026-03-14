import { TerminalBuffer } from './buffer.ts';
import { DiffEngine } from './diff.ts';
import { type Line } from '../types/grid.ts';
import { state } from '../core/state.ts';

export interface CompositeRequest {
  width: number;
  height: number;
  header: Line[];
  viewport: Line[];
  footer: Line[];
}

/**
 * Compositor - Authoritative TUI layout engine with Selection Overlay.
 */
export class Compositor {
  private lastBuffer: TerminalBuffer | null = null;
  private diffEngine = new DiffEngine();

  constructor(private stdout: NodeJS.WriteStream) {}

  public composite(params: CompositeRequest) {
    const { width, height, header, viewport, footer } = params;
    const newBuffer = new TerminalBuffer(width, height);

    // 1. Draw Header (Rows 0-1)
    header.forEach((line, i) => newBuffer.blitLine(i, line));

    // 2. Draw Viewport (Starting at Row 2)
    const viewportStartY = 2;
    const lineCount = state.history.getLineCount();
    const vHeight = height - header.length - footer.length;
    
    // Calculate the offset for bottom-anchored short history
    const offset = Math.max(0, vHeight - lineCount);

    viewport.forEach((line, i) => {
      const screenY = viewportStartY + i;
      if (screenY >= height) return;
      newBuffer.blitLine(screenY, line);

      // Audit Fix: Apply Selection Highlighting Overlay
      // Only highlight rows that actually contain history (past the bottom-anchor offset)
      if (i >= offset) {
        const absoluteRow = state.scrollTop + (i - offset);
        for (let x = 0; x < width; x++) {
          if (state.isCellSelected(x, absoluteRow)) {
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
