import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';

/**
 * TerminalBuffer - Represents a 2D grid of styled cells.
 */
export class TerminalBuffer {
  public cells: Line[];

  constructor(public width: number, public height: number) {
    this.cells = Array.from({ length: height }, () => createEmptyLine(width));
  }

  public setCell(x: number, y: number, cell: Partial<Cell>) {
    if (y >= 0 && y < this.height && x >= 0 && x < this.width) {
      this.cells[y][x] = { ...this.cells[y][x], ...cell };
    }
  }

  public getCell(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x];
  }

  public blitLine(row: number, line: Line) {
    if (row >= 0 && row < this.height) {
      this.cells[row] = [...line];
    }
  }

  public clone(): TerminalBuffer {
    const newBuf = new TerminalBuffer(this.width, this.height);
    newBuf.cells = this.cells.map(line => [...line]);
    return newBuf;
  }
}
