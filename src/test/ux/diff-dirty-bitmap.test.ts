// ---------------------------------------------------------------------------
// diff-dirty-bitmap.test.ts
// β2: DiffEngine skips rows that are clean in both old and new buffers.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { TerminalBuffer } from '../../renderer/buffer.ts';
import { DiffEngine } from '../../renderer/diff.ts';

const W = 200;
const H = 50;

function countCursorMoves(diff: string): number {
  // Each cursor move is \x1b[<row>;<col>H — count occurrences
  const matches = diff.match(/\x1b\[\d+;\d+H/g);
  return matches ? matches.length : 0;
}

function rowsInDiff(diff: string): Set<number> {
  const rows = new Set<number>();
  const re = /\x1b\[(\.\d+);\d+H/g;
  // Use manual match loop to capture group 1
  const re2 = /\x1b\[([0-9]+);[0-9]+H/g;
  let m: RegExpExecArray | null;
  while ((m = re2.exec(diff)) !== null) {
    rows.add(parseInt(m[1]!, 10));
  }
  return rows;
}

describe('TerminalBuffer dirty bitmap (β2 unit)', () => {
  test('dirtyRows starts all false', () => {
    const buf = new TerminalBuffer(W, H);
    expect(buf.dirtyRows.every(d => d === false)).toBe(true);
  });

  test('setCell marks row dirty', () => {
    const buf = new TerminalBuffer(W, H);
    buf.setCell(5, 10, { char: 'X', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false });
    expect(buf.dirtyRows[10]).toBe(true);
    expect(buf.dirtyRows[9]).toBe(false);
  });

  test('blitLine skips identical rows and marks changed rows dirty', () => {
    const buf = new TerminalBuffer(W, H);
    buf.blitLine(7, new Array(W).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }));
    expect(buf.dirtyRows[7]).toBe(false);
    buf.blitLine(7, [
      { char: 'X', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false },
      ...new Array(W - 1).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }),
    ]);
    expect(buf.dirtyRows[7]).toBe(true);
    expect(buf.dirtyRows[6]).toBe(false);
  });

  test('reset() clears all dirty flags (same size)', () => {
    const buf = new TerminalBuffer(W, H);
    buf.setCell(0, 0, { char: 'A', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false });
    buf.blitLine(3, new Array(W).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }));
    buf.reset(W, H);
    expect(buf.dirtyRows.every(d => d === false)).toBe(true);
  });

  test('reset() clears dirty flags on resize', () => {
    const buf = new TerminalBuffer(W, H);
    buf.setCell(0, 0, { char: 'A', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false });
    buf.reset(80, 24);
    expect(buf.dirtyRows.length).toBe(24);
    expect(buf.dirtyRows.every(d => d === false)).toBe(true);
  });
});

describe('DiffEngine row-level dirty skip (β2 perf)', () => {
  test('frame with single dirty row only produces cursor moves for that row', () => {
    const engine = new DiffEngine();

    // "old" frame: fully written (all rows dirty → all emitted on first frame)
    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }));
    }
    // First diff (null → oldBuf) establishes baseline
    engine.diff(null, oldBuf);

    // "new" frame: write only row 25 with a visible character
    const newBuf = new TerminalBuffer(W, H);
    // Only row 25 is dirty — all others start clean
    newBuf.blitLine(25, [
      { char: 'X', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false },
      ...new Array(W - 1).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }),
    ]);

    const diff = engine.diff(oldBuf, newBuf);
    const rows = rowsInDiff(diff);

    // Only row 26 (1-indexed) should appear in the diff
    expect(rows.has(26)).toBe(true);
    expect(rows.size).toBe(1);
  });

  test('frame with no dirty rows produces empty diff', () => {
    const engine = new DiffEngine();

    const buf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      buf.blitLine(y, new Array(W).fill({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }));
    }
    engine.diff(null, buf); // baseline

    // New buffer with no dirty rows
    const newBuf = new TerminalBuffer(W, H);
    const diff = engine.diff(buf, newBuf);
    expect(diff).toBe('');
  });
});
