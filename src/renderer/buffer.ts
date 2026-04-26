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
      // No-op guard: skip the dirty mark and allocation if every field in `cell`
      // already matches the current cell value (idempotent write).
      const current = this.cells[y][x]!;
      let changed = false;
      for (const k in cell) {
        if ((cell as unknown as Record<string, unknown>)[k] !== (current as unknown as Record<string, unknown>)[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      this.cells[y][x] = { ...current, ...cell };
      this.dirtyRows[y] = true;
    }
  }

  public getCell(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x];
  }

  public blitLine(row: number, line: Line): void {
    if (row >= 0 && row < this.height) {
      const current = this.cells[row]!;
      const next = createEmptyLine(this.width);
      for (let x = 0; x < Math.min(line.length, this.width); x++) {
        next[x] = { ...line[x]! };
      }
      if (linesEqual(current, next, this.width)) return;
      this.cells[row] = next;
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
  public reset(width: number, height: number, source?: TerminalBuffer | null): void {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.cells = Array.from({ length: height }, () => createEmptyLine(width));
      this.dirtyRows = new Array(height).fill(false);
    } else if (source && source.width === width && source.height === height) {
      for (let y = 0; y < this.height; y++) {
        this.cells[y] = source.cells[y]!.map(cell => ({ ...cell }));
        this.dirtyRows[y] = false;
      }
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

  public clearDirty(): void {
    this.dirtyRows.fill(false);
  }
}

function linesEqual(left: Line, right: Line, width: number): boolean {
  for (let x = 0; x < width; x++) {
    const a = left[x];
    const b = right[x];
    if (!a && !b) continue;
    if (!a || !b) return false;
    if (
      a.char !== b.char
      || a.fg !== b.fg
      || a.bg !== b.bg
      || a.bold !== b.bold
      || a.dim !== b.dim
      || a.underline !== b.underline
      || a.italic !== b.italic
      || a.strikethrough !== b.strikethrough
      || (a.link ?? '') !== (b.link ?? '')
    ) {
      return false;
    }
  }
  return true;
}
