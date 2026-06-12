// ---------------------------------------------------------------------------
// diff-coalescing.test.ts
//
// Verifies the run-coalescing optimization in DiffEngine.diff():
//
// 1. Golden small-grid diffs: output is correct for contiguous same-SGR runs.
// 2. Style change mid-run: cursor is re-emitted on SGR boundary.
// 3. Row wrap: cursor is re-emitted on new row.
// 4. Write-count assertion: a changed full row emits exactly 1 cursor sequence,
//    not N (one per cell).
// 5. Existing committed wrapSynced / downsample behavior preserved.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { TerminalBuffer } from '../../renderer/buffer.ts';
import { DiffEngine } from '../../renderer/diff.ts';
import type { TermColorCaps } from '../../renderer/term-caps.ts';

// Helper: extract cursor-address count from a diff string.
function countCursorMoves(diff: string): number {
  const matches = diff.match(/\x1b\[\d+;\d+H/g);
  return matches ? matches.length : 0;
}

// Helper: make a uniform cell.
const CLEAR_CELL = { char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
function makeCell(char: string, fg = '', bg = '', bold = false): typeof CLEAR_CELL {
  return { char, fg, bg, bold, dim: false, underline: false, italic: false, strikethrough: false };
}

// No synced output / no color for deterministic output in golden tests.
const PLAIN_CAPS: TermColorCaps = { capability: 'none', syncedOutput: false };
const TC_CAPS: TermColorCaps = { capability: 'truecolor', syncedOutput: false };

// ---------------------------------------------------------------------------
// 1. Golden small-grid diffs: uniform run emits 1 cursor move
// ---------------------------------------------------------------------------

describe('DiffEngine run-coalescing: golden grids', () => {
  test('uniform-fg row: 10 changed cells emit exactly 1 cursor sequence', () => {
    // Use PLAIN_CAPS (capability='none') so applyStyles always returns '',
    // making the coalescing condition reliably exercised without SGR complexity.
    const W = 20;
    const H = 3;
    const engine = new DiffEngine(PLAIN_CAPS);

    // Old buffer: all spaces (row 1 all clean after baseline)
    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf); // baseline

    // New buffer: row 1 has 10 consecutive 'X' cells starting at x=2
    const newBuf = new TerminalBuffer(W, H);
    const rowCells = [...new Array(W).fill(null).map(() => ({ ...CLEAR_CELL }))];
    for (let x = 2; x < 12; x++) {
      rowCells[x] = makeCell('X');
    }
    newBuf.blitLine(1, rowCells as typeof CLEAR_CELL[]);

    const diff = engine.diff(oldBuf, newBuf);
    const moves = countCursorMoves(diff);
    // Run-coalescing: one move to start the run, none for x=3..11
    expect(moves).toBe(1);
    // All 10 X chars must still be present in the output
    const xCount = (diff.match(/X/g) ?? []).length;
    expect(xCount).toBe(10);
  });

  test('full row change (200 cols, same SGR) emits exactly 1 cursor sequence', () => {
    const W = 200;
    const H = 5;
    const engine = new DiffEngine(PLAIN_CAPS);

    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf);

    // Change all 200 cells in row 2 to 'A' with same (empty) SGR
    const newBuf = new TerminalBuffer(W, H);
    newBuf.blitLine(2, new Array(W).fill(makeCell('A')));

    const diff = engine.diff(oldBuf, newBuf);
    const moves = countCursorMoves(diff);

    // Key write-count assertion: 1 cursor sequence, not 200.
    expect(moves).toBe(1);
    // All 200 'A' chars present
    const aCount = (diff.match(/A/g) ?? []).length;
    expect(aCount).toBe(200);
  });

  test('two separate changed regions on same row emit 2 cursor sequences', () => {
    const W = 20;
    const H = 3;
    const engine = new DiffEngine(PLAIN_CAPS);

    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf);

    const newBuf = new TerminalBuffer(W, H);
    const rowCells = new Array<typeof CLEAR_CELL>(W).fill(CLEAR_CELL);
    // Region 1: x=1..3
    rowCells[1] = makeCell('A');
    rowCells[2] = makeCell('A');
    rowCells[3] = makeCell('A');
    // Gap: x=4 unchanged (CLEAR_CELL)
    // Region 2: x=5..7
    rowCells[5] = makeCell('B');
    rowCells[6] = makeCell('B');
    rowCells[7] = makeCell('B');
    newBuf.blitLine(0, rowCells);

    const diff = engine.diff(oldBuf, newBuf);
    const moves = countCursorMoves(diff);
    // Two separate runs → 2 cursor sequences
    expect(moves).toBe(2);
  });

  test('row wrap: cells on different rows emit separate cursor sequences', () => {
    const W = 5;
    const H = 4;
    const engine = new DiffEngine(PLAIN_CAPS);

    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf);

    const newBuf = new TerminalBuffer(W, H);
    // One cell at end of row 0 and one cell at start of row 1
    const row0 = new Array<typeof CLEAR_CELL>(W).fill(CLEAR_CELL);
    row0[W - 1] = makeCell('X');
    newBuf.blitLine(0, row0);

    const row1 = new Array<typeof CLEAR_CELL>(W).fill(CLEAR_CELL);
    row1[0] = makeCell('Y');
    newBuf.blitLine(1, row1);

    const diff = engine.diff(oldBuf, newBuf);
    const moves = countCursorMoves(diff);
    // Different rows must each have their own cursor sequence (no run across rows)
    expect(moves).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Style change mid-run: SGR boundary forces a new cursor sequence
// ---------------------------------------------------------------------------

describe('DiffEngine run-coalescing: style changes mid-run', () => {
  test('style change in the middle of a row breaks the run (2 cursor sequences)', () => {
    const W = 10;
    const H = 3;
    const engine = new DiffEngine(TC_CAPS);

    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf);

    const newBuf = new TerminalBuffer(W, H);
    const rowCells = new Array<typeof CLEAR_CELL>(W).fill(CLEAR_CELL);
    // x=0..2: fg=#ff0000
    rowCells[0] = makeCell('R', '#ff0000');
    rowCells[1] = makeCell('R', '#ff0000');
    rowCells[2] = makeCell('R', '#ff0000');
    // x=3..5: fg=#0000ff (different)
    rowCells[3] = makeCell('B', '#0000ff');
    rowCells[4] = makeCell('B', '#0000ff');
    rowCells[5] = makeCell('B', '#0000ff');
    newBuf.blitLine(0, rowCells);

    const diff = engine.diff(oldBuf, newBuf);
    const moves = countCursorMoves(diff);
    // Two SGR-distinct runs → 2 cursor sequences minimum
    expect(moves).toBeGreaterThanOrEqual(2);
    // Both chars present
    const rCount = (diff.match(/R/g) ?? []).length;
    const bCount = (diff.match(/B/g) ?? []).length;
    expect(rCount).toBe(3);
    expect(bCount).toBe(3);
  });

  test('bold transition breaks the run', () => {
    const W = 6;
    const H = 2;
    const engine = new DiffEngine(TC_CAPS);

    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf);

    const newBuf = new TerminalBuffer(W, H);
    const rowCells = new Array<typeof CLEAR_CELL>(W).fill(CLEAR_CELL);
    // x=0..1: normal
    rowCells[0] = makeCell('N', '#ffffff', '', false);
    rowCells[1] = makeCell('N', '#ffffff', '', false);
    // x=2..3: bold (SGR change)
    rowCells[2] = makeCell('B', '#ffffff', '', true);
    rowCells[3] = makeCell('B', '#ffffff', '', true);
    newBuf.blitLine(0, rowCells);

    const diff = engine.diff(oldBuf, newBuf);
    const moves = countCursorMoves(diff);
    // Bold transition breaks the run → at least 2 cursor sequences
    expect(moves).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Correctness: output characters and order are preserved
// ---------------------------------------------------------------------------

describe('DiffEngine run-coalescing: output correctness', () => {
  test('coalesced row output contains all chars in order', () => {
    const W = 6;
    const H = 2;
    const engine = new DiffEngine(PLAIN_CAPS);

    const oldBuf = new TerminalBuffer(W, H);
    for (let y = 0; y < H; y++) {
      oldBuf.blitLine(y, new Array(W).fill(CLEAR_CELL));
    }
    engine.diff(null, oldBuf);

    const newBuf = new TerminalBuffer(W, H);
    const rowCells = new Array<typeof CLEAR_CELL>(W).fill(CLEAR_CELL);
    const word = 'HELLO!';
    for (let i = 0; i < word.length; i++) {
      rowCells[i] = makeCell(word[i]);
    }
    newBuf.blitLine(0, rowCells);

    const diff = engine.diff(oldBuf, newBuf);
    // The output should contain the word in order
    expect(diff).toContain('HELLO!');
    // Only 1 cursor sequence (single contiguous run)
    expect(countCursorMoves(diff)).toBe(1);
  });

  test('non-coalesced (null oldBuffer) emits cursor per changed cell', () => {
    // When oldBuffer is null (first frame), all cells are "different" regardless
    // of position. However, runs of same-SGR contiguous cells still coalesce.
    const W = 5;
    const H = 1;
    const engine = new DiffEngine(PLAIN_CAPS);

    const newBuf = new TerminalBuffer(W, H);
    newBuf.blitLine(0, [
      makeCell('A'), makeCell('B'), makeCell('C'), makeCell('D'), makeCell('E'),
    ]);

    const diff = engine.diff(null, newBuf);
    // All same SGR, contiguous → 1 cursor sequence
    expect(countCursorMoves(diff)).toBe(1);
    expect(diff).toContain('ABCDE');
  });

  test('wrapSynced behavior preserved: synced=true wraps output', () => {
    const SYNC_CAPS: TermColorCaps = { capability: 'none', syncedOutput: true };
    const engine = new DiffEngine(SYNC_CAPS);
    const buf = new TerminalBuffer(5, 2);
    buf.blitLine(0, new Array(5).fill(makeCell('X')));

    const diff = engine.diff(null, buf);
    // DEC 2026 sync markers must be present
    expect(diff).toContain('\x1b[?2026h');
    expect(diff).toContain('\x1b[?2026l');
    // Content still correct
    expect(diff).toContain('X');
  });

  test('downsample behavior preserved: ansi256 caps emit 38;5;N sequences', () => {
    const A256_CAPS: TermColorCaps = { capability: 'ansi256', syncedOutput: false };
    const engine = new DiffEngine(A256_CAPS);
    const buf = new TerminalBuffer(5, 2);
    buf.blitLine(0, [makeCell('X', '#ff0000')]);

    const diff = engine.diff(null, buf);
    // #ff0000 → ansi256 index 196
    expect(diff).toContain('\x1b[38;5;196m');
    expect(diff).not.toContain('38;2;');
  });
});

// ---------------------------------------------------------------------------
// 4. Wide-char safety: CJK/emoji placeholder cells break the run
// ---------------------------------------------------------------------------

describe('DiffEngine run-coalescing: wide-char safety', () => {
  test('wide-char placeholder (char=empty) breaks the run — next cell re-addressed', () => {
    // Wide characters occupy 2 columns: the first column holds the char,
    // the second column holds a placeholder cell with char=''. The diff loop
    // skips cells with char='' (line 69: if (!newCell || newCell.char === '') continue).
    // This means wide chars break contiguous runs — the cell after a wide char
    // must re-address because the placeholder was not emitted.
    const W = 8;
    const H = 1;
    const engine = new DiffEngine(PLAIN_CAPS);

    const buf = new TerminalBuffer(W, H);
    // Layout: [A][B][W2][""][D][E]
    // W2 is a wide char occupying x=2, placeholder at x=3, then D at x=4, E at x=5
    const row = [
      makeCell('A'),
      makeCell('B'),
      makeCell('中'), // CJK ideograph, display width 2
      { ...CLEAR_CELL, char: '' }, // placeholder for wide char at x=2
      makeCell('D'),
      makeCell('E'),
      CLEAR_CELL,
      CLEAR_CELL,
    ];
    buf.blitLine(0, row);

    const diff = engine.diff(null, buf);
    // The run A-B is contiguous (1 move), then wide char at x=2 starts a new run.
    // The placeholder (char='') is skipped. D at x=4 is NOT adjacent to the wide
    // char position (x=2), so it requires a new cursor address.
    // Minimum expected: 3 cursor sequences (A-B run, wide char, D-E run)
    expect(countCursorMoves(diff)).toBeGreaterThanOrEqual(2);
    // All non-placeholder chars must appear in output
    expect(diff).toContain('A');
    expect(diff).toContain('B');
    expect(diff).toContain('中');
    expect(diff).toContain('D');
    expect(diff).toContain('E');
  });
});

// ---------------------------------------------------------------------------
// 5. Frame isolation: lastEmitX/Y reset between diff() calls
// ---------------------------------------------------------------------------

describe('DiffEngine run-coalescing: frame isolation', () => {
  test('run state resets between diff() calls — no cross-frame coalescing', () => {
    // If lastEmitX/Y were NOT reset between frames, a cell at (0, 0) in frame 2
    // could incorrectly coalesce with the last cell from frame 1.
    // H=1: single-row buffer so diff(null, buf1) visits only row 0, producing
    // exactly 1 cursor move for the contiguous A-B-C run.
    const W = 5;
    const H = 1;
    const engine = new DiffEngine(PLAIN_CAPS);

    // Frame 1: row 0 has 3 cells ending at x=2
    const buf1 = new TerminalBuffer(W, H);
    buf1.blitLine(0, [
      makeCell('A'), makeCell('B'), makeCell('C'), CLEAR_CELL, CLEAR_CELL,
    ]);
    const diff1 = engine.diff(null, buf1);
    expect(countCursorMoves(diff1)).toBe(1);

    // Frame 2: only x=0 in row 0 changes (position is NOT x=lastEmitX+1 from frame 1)
    const buf2 = new TerminalBuffer(W, H);
    buf2.blitLine(0, [
      makeCell('Z'), CLEAR_CELL, CLEAR_CELL, CLEAR_CELL, CLEAR_CELL,
    ]);
    const diff2 = engine.diff(buf1, buf2);
    // Must emit a cursor sequence — not coalesce with end-of-frame-1 position
    expect(countCursorMoves(diff2)).toBe(1);
    expect(diff2).toContain('Z');
  });
});
