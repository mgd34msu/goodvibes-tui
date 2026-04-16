import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';

/**
 * TerminalBuffer - Represents a 2D grid of styled cells.
 */
export class TerminalBuffer {
  public cells: Line[];

  constructor(public width: number, public height: number) {
    this.cells = Array.from({ length: height }, () => createEmptyLine(width));
  }

  public setCell(x: number, y: number, cell: Partial<Cell>): void {
    if (y >= 0 && y < this.height && x >= 0 && x < this.width) {
      this.cells[y][x] = { ...this.cells[y][x], ...cell };
    }
  }

  public getCell(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x];
  }

  public blitLine(row: number, line: Line): void {
    if (row >= 0 && row < this.height) {
      this.cells[row] = [...line];
    }
  }

  public clone(): TerminalBuffer {
    const newBuf = new TerminalBuffer(this.width, this.height);
    newBuf.cells = this.cells.map(line => line.map(cell => ({ ...cell })));
    return newBuf;
  }

  /**
   * Reset all cells in-place to empty, reusing this buffer instance.
   * If dimensions changed, reallocates cells array.
   */
  public reset(width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.cells = Array.from({ length: height }, () => createEmptyLine(width));
    } else {
      for (let y = 0; y < this.height; y++) {
        const row = this.cells[y]!;
        for (let x = 0; x < this.width; x++) {
          row[x] = createEmptyCell();
        }
      }
    }
  }
}
