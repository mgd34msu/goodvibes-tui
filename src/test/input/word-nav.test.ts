import { describe, test, expect } from 'bun:test';
import { wordBoundaryBack, wordBoundaryForward } from '../../input/kill-ring.ts';

// ── wordBoundaryBack ──────────────────────────────────────────────────────

describe('wordBoundaryBack', () => {
  test('at position 0 returns 0', () => {
    expect(wordBoundaryBack('hello world', 0)).toBe(0);
  });

  test('moves back over trailing word chars', () => {
    // 'hello world', cursor at 11 (end) → skip 'world' → 6
    expect(wordBoundaryBack('hello world', 11)).toBe(6);
  });

  test('skips non-word chars before word', () => {
    // 'hello   world', cursor at 5+3+5=13 (end) → skip 'world' → 8
    expect(wordBoundaryBack('hello   world', 13)).toBe(8);
  });

  test('skips non-word chars when cursor is inside them', () => {
    // 'hello   ', cursor at 8 → skips spaces then 'hello' → 0
    expect(wordBoundaryBack('hello   ', 8)).toBe(0);
  });

  test('handles punctuation as non-word', () => {
    // 'foo.bar', cursor at 7 → skips 'bar' → 4
    expect(wordBoundaryBack('foo.bar', 7)).toBe(4);
  });

  test('cursor inside a word moves to word start', () => {
    // 'hello world', cursor at 8 (inside 'world') → 6
    expect(wordBoundaryBack('hello world', 8)).toBe(6);
  });

  test('handles unicode letters', () => {
    // 'café bar', cursor at 8 (end) → skip 'bar' → 5
    expect(wordBoundaryBack('café bar', 8)).toBe(5);
  });

  test('handles underscore as word char', () => {
    // 'foo_bar', cursor at 7 → skip entire 'foo_bar' → 0
    expect(wordBoundaryBack('foo_bar', 7)).toBe(0);
  });

  test('consecutive calls step word by word', () => {
    const s = 'one two three';
    const p1 = wordBoundaryBack(s, s.length); // skip 'three' → 8
    const p2 = wordBoundaryBack(s, p1);       // skip ' ' + 'two' → 4
    const p3 = wordBoundaryBack(s, p2);       // skip ' ' + 'one' → 0
    expect(p1).toBe(8);
    expect(p2).toBe(4);
    expect(p3).toBe(0);
  });
});

// ── wordBoundaryForward ───────────────────────────────────────────────────

describe('wordBoundaryForward', () => {
  test('at end of string returns length', () => {
    expect(wordBoundaryForward('hello', 5)).toBe(5);
  });

  test('moves forward over leading word chars', () => {
    // 'hello world', cursor at 0 → skip 'hello' → 5
    expect(wordBoundaryForward('hello world', 0)).toBe(5);
  });

  test('skips non-word chars then word chars', () => {
    // 'hello   world', cursor at 5 → skip spaces + 'world' → 13
    expect(wordBoundaryForward('hello   world', 5)).toBe(13);
  });

  test('cursor at non-word skips to next word end', () => {
    // '   hello', cursor at 0 → skip spaces + 'hello' → 8
    expect(wordBoundaryForward('   hello', 0)).toBe(8);
  });

  test('handles punctuation as non-word', () => {
    // 'foo.bar', cursor at 3 → skip '.' then 'bar' → 7
    expect(wordBoundaryForward('foo.bar', 3)).toBe(7);
  });

  test('cursor inside a word moves to word end', () => {
    // 'hello world', cursor at 7 (inside 'world') → 11
    expect(wordBoundaryForward('hello world', 7)).toBe(11);
  });

  test('handles unicode letters', () => {
    // 'café bar', cursor at 0 → skip 'café' → 4
    expect(wordBoundaryForward('café bar', 0)).toBe(4);
  });

  test('handles underscore as word char', () => {
    // 'foo_bar baz', cursor at 0 → skip 'foo_bar' → 7
    expect(wordBoundaryForward('foo_bar baz', 0)).toBe(7);
  });

  test('consecutive calls step word by word', () => {
    const s = 'one two three';
    const p1 = wordBoundaryForward(s, 0); // skip 'one' → 3
    const p2 = wordBoundaryForward(s, p1); // skip ' two' → 7
    const p3 = wordBoundaryForward(s, p2); // skip ' three' → 13
    expect(p1).toBe(3);
    expect(p2).toBe(7);
    expect(p3).toBe(13);
  });
});
