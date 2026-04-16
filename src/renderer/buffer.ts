import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';

/**
 * TerminalBuffer - Represents a 2D grid of styled cells.
 * Tracks a per-row dirty bitmap so the diff engine can skip rows that were
 * never written in the current frame.
 */
export class TerminalBuffer {
  public cells: Line[];
  /** dirtyRows[y] is true if row y was written since the last reset(). */
  public dirtyRows: boolean[];

  constructor(public width: number, public height: number) {
    this.cells = Array.from({ length: height }, () => createEmptyLine(width));
    this.dirtyRows = new Array(height).fill(false);
  }

  public setCell(x: number, y: number, cell: Partial<Cell>): void {
    if (y >= 0 && y < this.height && x >= 0 && x < this.width) {
      this.cells[y][x] = { ...this.cells[y][x], ...cell };
      this.dirtyRows[y] = true;
    }
  }

  public getCell(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x];
  }

  public blitLine(row: number, line: Line): void {
    if (row >= 0 && row < this.height) {
      this.cells[row] = [...line];
      this.dirtyRows[row] = true;
    }
  }

  public clone(): TerminalBuffer {
    const newBuf = new TerminalBuffer(this.width, this.height);
    newBuf.cells = this.cells.map(line => line.map(cell => ({ ...cell })));
    newBuf.dirtyRows = [...this.dirtyRows];
    return newBuf;
  }

  /**
   * Reset all cells in-place to empty, reusing this buffer instance.
   * If dimensions changed, reallocates cells array.
   * Always clears the dirty bitmap.
   */
  public reset(width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.cells = Array.from({ length: height }, () => createEmptyLine(width));
      this.dirtyRows = new Array(height).fill(false);
    } else {
      for (let y = 0; y < this.height; y++) {
        const row = this.cells[y]!;
        for (let x = 0; x < this.width; x++) {
          row[x] = createEmptyCell();
        }
        this.dirtyRows[y] = false;
      }
    }
  }
}
