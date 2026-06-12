import { describe, test, expect, beforeEach } from 'bun:test';
import { SearchManager } from '../../input/search.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import type { Cell } from '../../types/grid.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an InfiniteBuffer from an array of plain strings. */
function bufferFromLines(lines: string[]): InfiniteBuffer {
  const buf = new InfiniteBuffer();
  for (const text of lines) {
    const cells: Cell[] = Array.from(text).map(ch => ({
      char: ch,
      fg: '',
      bg: '',
      bold: false,
      italic: false,
      underline: false,
      dim: false,
      strikethrough: false,
    }));
    buf.addLine(cells);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchManager', () => {
  let sm: SearchManager;

  beforeEach(() => {
    sm = new SearchManager();
  });

  // --- open/close ---

  test('open() sets active=true and resets state', () => {
    sm.open();
    expect(sm.active).toBe(true);
    expect(sm.query).toBe('');
    expect(sm.matches).toHaveLength(0);
    expect(sm.currentMatch).toBe(0);
  });

  test('close() sets active=false', () => {
    sm.open();
    sm.close();
    expect(sm.active).toBe(false);
  });

  test('open() after a prior search resets matches', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(1);
    sm.open(); // re-open should reset
    expect(sm.matches).toHaveLength(0);
    expect(sm.query).toBe('');
    expect(sm.currentMatch).toBe(0);
  });

  // --- search() ---

  test('search() finds exact match on one line', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(1);
    expect(sm.matches[0]).toMatchObject({ line: 0, col: 0, length: 5 });
  });

  test('search() finds multiple matches on same line', () => {
    const buf = bufferFromLines(['abcabc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(2);
    expect(sm.matches[0]).toMatchObject({ line: 0, col: 0 });
    expect(sm.matches[1]).toMatchObject({ line: 0, col: 3 });
  });

  test('search() finds matches across multiple lines', () => {
    const buf = bufferFromLines(['foo bar', 'baz foo qux']);
    sm.open();
    sm.search('foo', buf);
    expect(sm.matches).toHaveLength(2);
    expect(sm.matches[0]).toMatchObject({ line: 0 });
    expect(sm.matches[1]).toMatchObject({ line: 1 });
  });

  test('search() is case-insensitive', () => {
    const buf = bufferFromLines(['Hello WORLD']);
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(1);
    sm.search('world', buf);
    expect(sm.matches).toHaveLength(1);
  });

  test('search() with empty query returns no matches', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('', buf);
    expect(sm.matches).toHaveLength(0);
  });

  test('search() with no matching text returns empty matches', () => {
    const buf = bufferFromLines(['hello world']);
    sm.open();
    sm.search('xyz', buf);
    expect(sm.matches).toHaveLength(0);
  });

  test('search() on empty buffer returns no matches', () => {
    const buf = new InfiniteBuffer();
    sm.open();
    sm.search('hello', buf);
    expect(sm.matches).toHaveLength(0);
  });

  // --- nextMatch() / prevMatch() ---

  test('nextMatch() advances currentMatch', () => {
    const buf = bufferFromLines(['abc abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(3);
    expect(sm.currentMatch).toBe(0);
    sm.nextMatch();
    expect(sm.currentMatch).toBe(1);
    sm.nextMatch();
    expect(sm.currentMatch).toBe(2);
  });

  test('nextMatch() wraps around at end', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(2);
    sm.nextMatch(); // -> 1
    sm.nextMatch(); // -> 0 (wrap)
    expect(sm.currentMatch).toBe(0);
  });

  test('prevMatch() goes backwards', () => {
    const buf = bufferFromLines(['abc abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch(); // -> 1
    sm.nextMatch(); // -> 2
    sm.prevMatch(); // -> 1
    expect(sm.currentMatch).toBe(1);
  });

  test('prevMatch() wraps around at start', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.currentMatch).toBe(0);
    sm.prevMatch(); // -> wraps to 1
    expect(sm.currentMatch).toBe(1);
  });

  test('nextMatch() does nothing when no matches', () => {
    sm.open();
    sm.nextMatch();
    expect(sm.currentMatch).toBe(0);
  });

  test('prevMatch() does nothing when no matches', () => {
    sm.open();
    sm.prevMatch();
    expect(sm.currentMatch).toBe(0);
  });

  // --- getCurrentMatchLine() ---

  test('getCurrentMatchLine() returns correct line for current match', () => {
    const buf = bufferFromLines(['no match here', 'target', 'also target']);
    sm.open();
    sm.search('target', buf);
    expect(sm.matches).toHaveLength(2);
    expect(sm.getCurrentMatchLine()).toBe(1);
    sm.nextMatch();
    expect(sm.getCurrentMatchLine()).toBe(2);
  });

  test('getCurrentMatchLine() returns -1 when no matches', () => {
    sm.open();
    expect(sm.getCurrentMatchLine()).toBe(-1);
  });

  test('getCurrentMatchLine() returns -1 after search with no results', () => {
    const buf = bufferFromLines(['hello']);
    sm.open();
    sm.search('xyz', buf);
    expect(sm.getCurrentMatchLine()).toBe(-1);
  });

  // --- getMatchesOnLine() (a.k.a. getMatchesForLine) ---

  test('getMatchesOnLine() returns all matches on the given line', () => {
    const buf = bufferFromLines(['abc def abc', 'xyz']);
    sm.open();
    sm.search('abc', buf);
    const line0 = sm.getMatchesOnLine(0);
    expect(line0).toHaveLength(2);
    const line1 = sm.getMatchesOnLine(1);
    expect(line1).toHaveLength(0);
  });

  test('getMatchesOnLine() returns empty when query is empty', () => {
    const buf = bufferFromLines(['abc']);
    sm.open();
    expect(sm.getMatchesOnLine(0)).toHaveLength(0);
  });

  // --- wrapAround ---

  test('wrapAround is false initially', () => {
    sm.open();
    expect(sm.wrapAround).toBe(false);
  });

  test('wrapAround cleared by search()', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch();
    sm.nextMatch(); // wraps
    expect(sm.wrapAround).toBe(true);
    sm.search('abc', buf); // re-search clears it
    expect(sm.wrapAround).toBe(false);
  });

  test('wrapAround set when nextMatch() wraps past last match', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.matches).toHaveLength(2);
    sm.nextMatch(); // 0 -> 1, no wrap
    expect(sm.wrapAround).toBe(false);
    sm.nextMatch(); // 1 -> 0, wraps
    expect(sm.wrapAround).toBe(true);
    expect(sm.currentMatch).toBe(0);
  });

  test('wrapAround set when prevMatch() wraps before first match', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    expect(sm.currentMatch).toBe(0);
    sm.prevMatch(); // 0 -> 1, wraps
    expect(sm.wrapAround).toBe(true);
    expect(sm.currentMatch).toBe(1);
  });

  test('wrapAround cleared after non-wrapping navigation', () => {
    const buf = bufferFromLines(['abc abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch(); // 0 -> 1
    sm.nextMatch(); // 1 -> 2
    sm.nextMatch(); // 2 -> 0, wraps
    expect(sm.wrapAround).toBe(true);
    sm.nextMatch(); // 0 -> 1, no wrap
    expect(sm.wrapAround).toBe(false);
  });

  test('wrapAround false when no matches', () => {
    sm.open();
    sm.nextMatch();
    expect(sm.wrapAround).toBe(false);
    sm.prevMatch();
    expect(sm.wrapAround).toBe(false);
  });

  test('open() resets wrapAround', () => {
    const buf = bufferFromLines(['abc abc']);
    sm.open();
    sm.search('abc', buf);
    sm.nextMatch();
    sm.nextMatch(); // wraps
    expect(sm.wrapAround).toBe(true);
    sm.open();
    expect(sm.wrapAround).toBe(false);
  });
});
