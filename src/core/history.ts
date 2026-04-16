import { type Line, createEmptyLine } from '../types/grid.ts';

/**
 * InfiniteBuffer - Manages the complete conversation history as a list of lines.
 */
export class InfiniteBuffer {
  private lines: Line[] = [];

  public addLine(line: Line): void {
    this.lines.push(line);
  }

  public addLines(lines: Line[]): void {
    this.lines.push(...lines);
  }

  public getLineCount(): number {
    return this.lines.length;
  }

  public getAllLines(): Line[] {
    return this.lines;
  }

  public getSnapshot(startLine: number, height: number, width: number): Line[] {
    const end = Math.min(this.lines.length, startLine + height);
    const slice = this.lines.slice(startLine, end);

    while (slice.length < height) {
      slice.unshift(createEmptyLine(width));
    }

    return slice;
  }

  public clear(): void {
    this.lines = [];
  }

  public truncateToLine(lineIndex: number): void {
    if (lineIndex >= 0 && lineIndex < this.lines.length) {
      this.lines.length = lineIndex;
    }
  }
}
