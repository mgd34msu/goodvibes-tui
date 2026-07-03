import { describe, test, expect } from 'bun:test';
import { renderCodeBlock } from '../../renderer/code-block.ts';
import { LAYOUT } from '../../renderer/layout.ts';
import { lineToString } from '../setup.ts';

const WIDTH = 80;

const lineText = lineToString;

describe('renderCodeBlock', () => {
  test('returns Line array', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('each line has correct width', () => {
    const result = renderCodeBlock(['const x = 1;', 'let y = 2;'], 'ts', WIDTH);
    for (const line of result) {
      expect(line.length).toBe(WIDTH);
    }
  });

  test('first line is a language header bar', () => {
    const result = renderCodeBlock(['code here'], 'ts', WIDTH);
    const headerText = lineText(result[0]);
    expect(headerText).toContain('ts');
  });

  test('shows generic code label when no language specified', () => {
    const result = renderCodeBlock(['line'], '', WIDTH);
    const headerText = lineText(result[0]);
    expect(headerText).toContain('code');
  });

  test('contains code content in body lines', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    // Skip header (index 0) and footer (last)
    const bodyLines = result.slice(1, -1);
    const allText = bodyLines.map(lineText).join('\n');
    expect(allText).toContain('x');
  });

  test('includes line numbers in body lines', () => {
    const result = renderCodeBlock(['first', 'second', 'third'], 'ts', WIDTH);
    const bodyLines = result.slice(1, -1);
    // Line numbers should appear as digits
    const firstBody = lineText(bodyLines[0]);
    expect(firstBody).toMatch(/\d/);
  });

  test('has a footer line after code', () => {
    const result = renderCodeBlock(['x'], 'ts', WIDTH);
    // Should be: header + 1 code line + footer = 3 lines minimum
    expect(result.length).toBeGreaterThanOrEqual(3);
    // Footer is last line, its chars should all be spaces
    const footerText = result[result.length - 1].map((c) => c.char).join('');
    expect(footerText.trim()).toBe('');
  });

  test('handles empty code lines array', () => {
    const result = renderCodeBlock([], 'ts', WIDTH);
    // Should at minimum have header and footer
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test('handles TypeScript language detection', () => {
    const result = renderCodeBlock(['const x = 1;'], 'typescript', WIDTH);
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles python language', () => {
    const result = renderCodeBlock(['def foo():', '  return 42'], 'python', WIDTH);
    const bodyLines = result.slice(1, -1);
    const text = bodyLines.map(lineText).join('\n');
    expect(text).toContain('foo');
  });

  test('handles bash language', () => {
    const result = renderCodeBlock(['echo hello'], 'bash', WIDTH);
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles json language', () => {
    const result = renderCodeBlock(['{"key": "value"}'], 'json', WIDTH);
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles unknown language without crash', () => {
    const result = renderCodeBlock(['some content'], 'cobol', WIDTH);
    expect(Array.isArray(result)).toBe(true);
  });

  test('code lines have dark background color', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    // Body lines (index 1) have bg #0d0d0d
    const bodyLine = result[1];
    const codeCells = bodyLine.filter((c) => c.char !== ' ');
    if (codeCells.length > 0) {
      expect(codeCells[0].bg).toBe('#0d0d0d');
    }
  });

  test('body rows keep the shared right margin unpainted', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    const bodyLine = result[1];
    const contentEnd = WIDTH - LAYOUT.RIGHT_MARGIN;

    for (let x = contentEnd; x < WIDTH; x++) {
      expect(bodyLine[x]?.bg).toBe('');
    }
  });

  test('a wide glyph landing on the last body column does not spill its placeholder into the right margin', () => {
    const width = 20;
    const effectiveWidth = width - LAYOUT.RIGHT_MARGIN; // 18
    // 13 single-width filler chars push cx from leftMargin(4) to 17 —
    // effectiveWidth - 1, the last column inside the body. The wide glyph
    // ('日', display width 2) then lands exactly on that last column, so its
    // placeholder cell would fall at column effectiveWidth (18) if bounded
    // against the full line width instead of the body's own edge.
    const codeLine = 'x'.repeat(13) + '日' + 'zz';
    const result = renderCodeBlock([codeLine], '', width, { showLineNumbers: false });
    const bodyLine = result[1];

    expect(bodyLine[effectiveWidth - 1].char).toBe('日');
    // The margin column must stay the untouched default cell, not a
    // wide-glyph placeholder bleeding out of the body.
    expect(bodyLine[effectiveWidth].char).toBe(' ');
    expect(bodyLine[effectiveWidth].bg).toBe('');
  });

  test('header has distinctive background color', () => {
    const result = renderCodeBlock(['x'], 'ts', WIDTH);
    const headerCells = result[0].filter((c) => c.char !== ' ');
    if (headerCells.length > 0) {
      // Header uses #4ec9b0 teal background
      expect(headerCells[0].bg).toBe('#4ec9b0');
    }
  });
});
