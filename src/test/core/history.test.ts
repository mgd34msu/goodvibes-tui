import { describe, test, expect, beforeEach } from 'bun:test';
import { InfiniteBuffer } from '../../core/history.ts';
import { createEmptyLine, createStyledCell } from '../../types/grid.ts';
import type { Line } from '../../types/grid.ts';

const WIDTH = 80;

function makeLine(text: string): Line {
  const line: Line = createEmptyLine(WIDTH);
  for (let i = 0; i < text.length && i < WIDTH; i++) {
    line[i] = createStyledCell(text[i]);
  }
  return line;
}

describe('InfiniteBuffer', () => {
  let buffer: InfiniteBuffer;

  beforeEach(() => {
    buffer = new InfiniteBuffer();
  });

  describe('addLine / getLineCount', () => {
    test('starts with zero lines', () => {
      expect(buffer.getLineCount()).toBe(0);
    });

    test('addLine increments line count', () => {
      buffer.addLine(makeLine('hello'));
      expect(buffer.getLineCount()).toBe(1);
    });

    test('addLine stores multiple lines in order', () => {
      buffer.addLine(makeLine('line1'));
      buffer.addLine(makeLine('line2'));
      expect(buffer.getLineCount()).toBe(2);
    });
  });

  describe('addLines', () => {
    test('adds multiple lines at once', () => {
      buffer.addLines([makeLine('a'), makeLine('b'), makeLine('c')]);
      expect(buffer.getLineCount()).toBe(3);
    });

    test('addLines with empty array leaves count unchanged', () => {
      buffer.addLine(makeLine('x'));
      buffer.addLines([]);
      expect(buffer.getLineCount()).toBe(1);
    });
  });

  describe('getAllLines', () => {
    test('returns empty array initially', () => {
      expect(buffer.getAllLines()).toEqual([]);
    });

    test('returns all added lines', () => {
      const line1 = makeLine('foo');
      const line2 = makeLine('bar');
      buffer.addLine(line1);
      buffer.addLine(line2);
      const all = buffer.getAllLines();
      expect(all).toHaveLength(2);
      expect(all[0]).toBe(line1);
      expect(all[1]).toBe(line2);
    });
  });

  describe('getSnapshot', () => {
    test('returns requested height lines padded with empty lines when buffer is small', () => {
      buffer.addLine(makeLine('only'));
      const snapshot = buffer.getSnapshot(0, 5, WIDTH);
      expect(snapshot).toHaveLength(5);
    });

    test('returns slice of lines when buffer is larger than height', () => {
      for (let i = 0; i < 10; i++) buffer.addLine(makeLine(`line${i}`));
      const snapshot = buffer.getSnapshot(0, 5, WIDTH);
      expect(snapshot).toHaveLength(5);
    });

    test('startLine offset slices from the correct position', () => {
      for (let i = 0; i < 5; i++) buffer.addLine(makeLine(`line${i}`));
      const snapshot = buffer.getSnapshot(2, 3, WIDTH);
      // Lines 2,3,4 — the char at position 0 of line2 should be 'l' (from 'line2')
      expect(snapshot[0][0].char).toBe('l');
    });

    test('empty buffer returns full height of empty lines', () => {
      const snapshot = buffer.getSnapshot(0, 3, WIDTH);
      expect(snapshot).toHaveLength(3);
      // All cells should be spaces (empty lines)
      for (const line of snapshot) {
        for (const cell of line) {
          expect(cell.char).toBe(' ');
        }
      }
    });

    test('empty lines have correct width', () => {
      const snapshot = buffer.getSnapshot(0, 4, WIDTH);
      for (const line of snapshot) {
        expect(line).toHaveLength(WIDTH);
      }
    });

    test('startLine past end of buffer returns all empty lines', () => {
      buffer.addLine(makeLine('only'));
      const snapshot = buffer.getSnapshot(10, 4, WIDTH);
      expect(snapshot).toHaveLength(4);
      for (const line of snapshot) {
        expect(line.every((c) => c.char === ' ')).toBe(true);
      }
    });
  });

  describe('clear', () => {
    test('clears all lines', () => {
      buffer.addLine(makeLine('hello'));
      buffer.addLine(makeLine('world'));
      buffer.clear();
      expect(buffer.getLineCount()).toBe(0);
    });

    test('getAllLines returns empty after clear', () => {
      buffer.addLine(makeLine('x'));
      buffer.clear();
      expect(buffer.getAllLines()).toEqual([]);
    });

    test('can add lines after clear', () => {
      buffer.addLine(makeLine('before'));
      buffer.clear();
      buffer.addLine(makeLine('after'));
      expect(buffer.getLineCount()).toBe(1);
    });
  });
});
