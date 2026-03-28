import { describe, test, expect } from 'bun:test';
import { renderHistorySearchOverlay } from '../../renderer/history-search-overlay.ts';
import { HistorySearch } from '../../input/input-history.ts';
import { lineToString } from '../setup.ts';

const W = 80;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSearch(entries: string[]): HistorySearch {
  return new HistorySearch(() => entries);
}

/** Build a minimal HistorySearch in a known state. */
function searchWith(entries: string[], query: string): HistorySearch {
  const hs = makeSearch(entries);
  hs.open('');
  hs.search(query);
  return hs;
}

// ---------------------------------------------------------------------------
// renderHistorySearchOverlay — basic output shape
// ---------------------------------------------------------------------------

describe('renderHistorySearchOverlay', () => {
  test('returns exactly one Line', () => {
    const hs = makeSearch([]);
    hs.open('');
    const lines = renderHistorySearchOverlay(hs, W);
    expect(lines).toHaveLength(1);
  });

  test('each line has exactly `width` cells', () => {
    const hs = makeSearch([]);
    hs.open('');
    const lines = renderHistorySearchOverlay(hs, W);
    expect(lines[0].length).toBe(W);
  });

  test('returns empty array when width <= 0', () => {
    const hs = makeSearch([]);
    hs.open('');
    expect(renderHistorySearchOverlay(hs, 0)).toHaveLength(0);
    expect(renderHistorySearchOverlay(hs, -1)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // With match
  // ---------------------------------------------------------------------------

  test('with match: shows (reverse-i-search) prefix', () => {
    const hs = searchWith(['git status'], 'git');
    const lines = renderHistorySearchOverlay(hs, W);
    const text = lineToString(lines[0]);
    expect(text).toContain('(reverse-i-search)');
    expect(text).not.toContain('failed');
  });

  test('with match: shows the query in the label', () => {
    const hs = searchWith(['git status'], 'git');
    const lines = renderHistorySearchOverlay(hs, W);
    const text = lineToString(lines[0]);
    expect(text).toContain('git');
  });

  test('with match: shows the matched entry text', () => {
    const hs = searchWith(['git status'], 'git');
    const lines = renderHistorySearchOverlay(hs, W);
    const text = lineToString(lines[0]);
    expect(text).toContain('git status');
  });

  test('with match: matched cells have bold+underline highlighting', () => {
    const hs = searchWith(['git status'], 'git');
    const lines = renderHistorySearchOverlay(hs, W);
    const line = lines[0];
    // Find cells that are bold+underline (highlight region)
    const highlighted = line.filter(c => c.bold && c.underline);
    expect(highlighted.length).toBeGreaterThan(0);
    // The highlighted chars should spell out "git"
    const highlightedText = highlighted.map(c => c.char).join('');
    expect(highlightedText).toBe('git');
  });

  // ---------------------------------------------------------------------------
  // Without match (empty query)
  // ---------------------------------------------------------------------------

  test('without match (empty query): shows (reverse-i-search) prefix', () => {
    const hs = makeSearch([]);
    hs.open('');
    const lines = renderHistorySearchOverlay(hs, W);
    const text = lineToString(lines[0]);
    expect(text).toContain('(reverse-i-search)');
    expect(text).not.toContain('failed');
  });

  test('without match (empty query): no highlighted cells', () => {
    const hs = makeSearch([]);
    hs.open('');
    const lines = renderHistorySearchOverlay(hs, W);
    const highlighted = lines[0].filter(c => c.bold && c.underline);
    expect(highlighted).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Failed search (query present, no match found)
  // ---------------------------------------------------------------------------

  test('failed search: shows (failed reverse-i-search) prefix', () => {
    const hs = searchWith([], 'xyz');
    const lines = renderHistorySearchOverlay(hs, W);
    const text = lineToString(lines[0]);
    expect(text).toContain('(failed reverse-i-search)');
  });

  test('failed search: no highlighted cells', () => {
    const hs = searchWith([], 'xyz');
    const lines = renderHistorySearchOverlay(hs, W);
    const highlighted = lines[0].filter(c => c.bold && c.underline);
    expect(highlighted).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // CJK wide-character truncation correctness
  // ---------------------------------------------------------------------------

  test('CJK match text does not overflow line width', () => {
    // Each CJK char is 2 columns; 10 chars = 20 columns
    const cjkEntry = '日本語テスト入力文字';
    const hs = searchWith([cjkEntry], '日');
    const lines = renderHistorySearchOverlay(hs, W);
    expect(lines[0].length).toBe(W);
  });

  test('truncateToWidth pads line to exactly width columns', () => {
    // Very narrow width forces truncation
    const hs = searchWith(['hello world'], 'hello');
    const narrow = 20;
    const lines = renderHistorySearchOverlay(hs, narrow);
    expect(lines[0].length).toBe(narrow);
  });
});
