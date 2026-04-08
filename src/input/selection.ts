import type { InfiniteBuffer } from '../core/history.ts';
import type { Cell } from '../types/grid.ts';

export interface SelectionPoint {
  col: number;
  row: number;
}

/**
 * SelectionManager - Owns text selection state.
 * Extracted from StateManager. Requires access to the history buffer
 * and scroll state (scrollTop, viewportHeight) at call time.
 */
export class SelectionManager {
  public anchor: SelectionPoint | null = null;
  public focus: SelectionPoint | null = null;
  public isDragging = false;

  private screenToAbsoluteRow(viewportRow: number, scrollTop: number, vHeight: number, lineCount: number): number {
    const offset = Math.max(0, vHeight - lineCount);
    return scrollTop + (viewportRow - offset);
  }

  public startSelection(col: number, viewportRow: number, scrollTop: number, vHeight: number, lineCount: number): void {
    const absoluteRow = this.screenToAbsoluteRow(viewportRow, scrollTop, vHeight, lineCount);
    this.anchor = { col, row: absoluteRow };
    this.focus = { col, row: absoluteRow };
    this.isDragging = true;
  }

  public extendSelection(col: number, viewportRow: number, scrollTop: number, vHeight: number, lineCount: number): void {
    if (!this.isDragging) return;
    const absoluteRow = this.screenToAbsoluteRow(viewportRow, scrollTop, vHeight, lineCount);
    this.focus = { col, row: absoluteRow };
  }

  public endSelection(): void {
    this.isDragging = false;
  }

  public clearSelection(): void {
    this.anchor = null;
    this.focus = null;
    this.isDragging = false;
  }

  public hasSelection(): boolean {
    if (!this.anchor || !this.focus) return false;
    return this.anchor.row !== this.focus.row || this.anchor.col !== this.focus.col;
  }

  public getSelectedText(history: InfiniteBuffer): string {
    if (!this.anchor || !this.focus) return '';

    const start =
      this.anchor.row < this.focus.row ||
      (this.anchor.row === this.focus.row && this.anchor.col <= this.focus.col)
        ? this.anchor
        : this.focus;
    const end = start === this.anchor ? this.focus : this.anchor;

    const lines: string[] = [];
    const allLines = history.getAllLines();

    for (let r = Math.max(0, start.row); r <= Math.min(allLines.length - 1, end.row); r++) {
      const line = allLines[r];
      if (!line) continue;

      const startCol = r === start.row ? start.col : 0;
      const endCol = r === end.row ? end.col : line.length;
      const gutterEnd = this.findLineNumberGutterEnd(line);
      const effectiveStartCol = startCol < gutterEnd ? gutterEnd : startCol;

      let lineText = '';
      for (let c = Math.max(0, effectiveStartCol); c < Math.min(line.length, endCol); c++) {
        const cell = line[c];
        if (cell && cell.char !== '') lineText += cell.char;
      }

      const trimmed = this.stripDecorativePrefix(lineText.trim());
      if (trimmed || r === start.row || r === end.row) {
        lines.push(trimmed);
      }
    }

    return lines.join('\n');
  }

  private findLineNumberGutterEnd(line: Cell[]): number {
    let i = 0;
    while (i < line.length && line[i]?.char === ' ' && !line[i]?.dim) i++;
    const start = i;
    let sawDigit = false;
    while (i < line.length) {
      const cell = line[i];
      const ch = cell?.char ?? '';
      if (cell?.dim && ch !== '' && /[0-9 │]/.test(ch)) {
        if (/[0-9]/.test(ch)) sawDigit = true;
        i++;
        continue;
      }
      break;
    }
    if (!sawDigit) return 0;
    if (i < line.length && line[i]?.char === ' ') i++;
    return i > start ? i : 0;
  }

  private stripDecorativePrefix(text: string): string {
    return text
      .replace(/^(?:[▸▾▶►●○◆▲△▼▽•✕✓▌]\s+)+/u, '')
      .replace(/^\[(?:x|~| )\]\s+/u, '')
      .trimEnd();
  }

  public isCellSelected(col: number, absoluteRow: number): boolean {
    if (!this.anchor || !this.focus) return false;
    const start =
      this.anchor.row < this.focus.row ||
      (this.anchor.row === this.focus.row && this.anchor.col <= this.focus.col)
        ? this.anchor
        : this.focus;
    const end = start === this.anchor ? this.focus : this.anchor;
    if (absoluteRow < start.row || absoluteRow > end.row) return false;
    if (absoluteRow === start.row && absoluteRow === end.row)
      return col >= start.col && col < end.col;
    if (absoluteRow === start.row) return col >= start.col;
    if (absoluteRow === end.row) return col < end.col;
    return true;
  }
}
