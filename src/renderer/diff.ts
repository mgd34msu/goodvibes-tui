import { TerminalBuffer } from './buffer.ts';
import { type Cell } from '../types/grid.ts';

/**
 * DiffEngine - Generates minimal ANSI updates between two buffers.
 */
export class DiffEngine {
  private lastFg = '';
  private lastBg = '';
  private lastBold = false;
  private lastDim = false;

  public diff(oldBuffer: TerminalBuffer | null, newBuffer: TerminalBuffer): string {
    let output = '';
    
    for (let y = 0; y < newBuffer.height; y++) {
      for (let x = 0; x < newBuffer.width; x++) {
        const oldCell = oldBuffer?.getCell(x, y);
        const newCell = newBuffer.cells[y][x];

        if (newCell.char === '') continue;

        if (this.isCellDifferent(oldCell, newCell)) {
          output += `\x1b[${y + 1};${x + 1}H`;
          output += this.applyStyles(newCell);
          output += newCell.char;
        }
      }
    }

    return output;
  }

  private isCellDifferent(a: Cell | undefined, b: Cell): boolean {
    if (!a) return true;
    return a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.dim !== b.dim;
  }

  private sanitizeColor(color: string): string {
    if (color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `${r};${g};${b}`;
    }
    return color;
  }

  private applyStyles(cell: Cell): string {
    let style = '';
    const fg = this.sanitizeColor(cell.fg);
    const bg = this.sanitizeColor(cell.bg);

    if (fg !== this.lastFg || bg !== this.lastBg || cell.bold !== this.lastBold || cell.dim !== this.lastDim) {
      style += '\x1b[0m'; // Reset
      if (cell.bold) style += '\x1b[1m';
      if (cell.dim) style += '\x1b[2m';
      
      if (fg) {
        const isRgb = fg.includes(';');
        style += isRgb ? `\x1b[38;2;${fg}m` : `\x1b[38;5;${fg}m`;
      }
      if (bg) {
        const isRgb = bg.includes(';');
        style += isRgb ? `\x1b[48;2;${bg}m` : `\x1b[48;5;${bg}m`;
      }
      
      this.lastFg = fg;
      this.lastBg = bg;
      this.lastBold = cell.bold;
      this.lastDim = cell.dim;
    }
    return style;
  }
}
