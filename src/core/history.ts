import { type Line, createEmptyLine } from '../types/grid.ts';

/**
 * InfiniteBuffer - Manages the complete conversation history as a list of lines.
 */
export class InfiniteBuffer {
  private lines: Line[] = [];

  public addLine(line: Line) {
    this.lines.push(line);
  }

  public addLines(lines: Line[]) {
    this.lines.push(...lines);
  }

  public getLineCount(): number {
    return this.lines.length;
  }

  /**
   * getAllLines - Provides access to the full raw line list.
   */
  public getAllLines(): Line[] {
    return this.lines;
  }

  /**
   * Takes a snapshot of the buffer for a specific viewport window.
   */
  public getSnapshot(startLine: number, height: number, width: number): Line[] {
    const end = Math.min(this.lines.length, startLine + height);
    const slice = this.lines.slice(startLine, end);
    
    // Bottom-anchor logic: prepend empty space
    while (slice.length < height) {
      slice.unshift(createEmptyLine(width));
    }
    
    return slice;
  }

  public clear() {
    this.lines = [];
  }

  /** Truncate the buffer to the given line count (remove all lines from lineIndex onward). */
  public truncateToLine(lineIndex: number): void {
    if (lineIndex >= 0 && lineIndex < this.lines.length) {
      this.lines.length = lineIndex;
    }
  }
}
