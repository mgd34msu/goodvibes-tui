import { describe, test, expect, beforeEach } from 'bun:test';
import { HistorySearch } from '../../input/input-history.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSearch(entries: string[]): HistorySearch {
  return new HistorySearch(() => entries);
}

// ---------------------------------------------------------------------------
// open() / close() lifecycle
// ---------------------------------------------------------------------------

describe('HistorySearch: lifecycle', () => {
  test('open() sets active=true and resets state', () => {
    const hs = makeSearch(['hello']);
    hs.open('draft');
    expect(hs.active).toBe(true);
    expect(hs.query).toBe('');
    expect(hs.matches).toHaveLength(0);
    expect(hs.matchIndex).toBe(0);
  });

  test('open() saves the draft', () => {
    const hs = makeSearch([]);
    hs.open('my draft');
    expect(hs.savedDraft).toBe('my draft');
  });

  test('cancel() deactivates and returns saved draft', () => {
    const hs = makeSearch(['git status']);
    hs.open('my draft');
    const result = hs.cancel();
    expect(result).toBe('my draft');
    expect(hs.active).toBe(false);
    expect(hs.query).toBe('');
  });

  test('accept() deactivates and returns matched entry', () => {
    const hs = makeSearch(['git commit', 'git status']);
    hs.open('');
    hs.search('git');
    const result = hs.accept();
    expect(result).toBe('git commit');
    expect(hs.active).toBe(false);
  });

  test('accept() returns empty string when no match', () => {
    const hs = makeSearch([]);
    hs.open('');
    const result = hs.accept();
    expect(result).toBe('');
  });

  test('re-open after prior search resets state', () => {
    const hs = makeSearch(['hello world']);
    hs.open('');
    hs.search('hello');
    expect(hs.matches).toHaveLength(1);
    hs.open('new draft');
    expect(hs.matches).toHaveLength(0);
    expect(hs.query).toBe('');
    expect(hs.matchIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// search(), matching behaviour
// ---------------------------------------------------------------------------

describe('HistorySearch: search()', () => {
  let hs: HistorySearch;

  beforeEach(() => {
    hs = makeSearch(['git commit -m "fix"', 'git status', 'npm install', 'GIT LOG']);
    hs.open('');
  });

  test('case-insensitive matching', () => {
    hs.search('git');
    // matches 'git commit', 'git status', and 'GIT LOG'
    expect(hs.matches).toHaveLength(3);
  });

  test('empty query returns no matches', () => {
    hs.search('');
    expect(hs.matches).toHaveLength(0);
  });

  test('no matching entries returns empty matches', () => {
    hs.search('zzz-no-match');
    expect(hs.matches).toHaveLength(0);
  });

  test('match contains correct entry, matchStart and matchLength', () => {
    hs.search('status');
    expect(hs.matches).toHaveLength(1);
    expect(hs.matches[0].entry).toBe('git status');
    expect(hs.matches[0].matchStart).toBe(4);
    expect(hs.matches[0].matchLength).toBe(6);
  });

  test('resets matchIndex to 0 on each search', () => {
    hs.search('git');
    hs.stepOlder();
    expect(hs.matchIndex).toBe(1);
    hs.search('git');
    expect(hs.matchIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendChar() / deleteChar() incremental search
// ---------------------------------------------------------------------------

describe('HistorySearch: appendChar() / deleteChar()', () => {
  let hs: HistorySearch;

  beforeEach(() => {
    hs = makeSearch(['git commit', 'git status', 'npm install']);
    hs.open('');
  });

  test('appendChar() extends query and re-runs search', () => {
    hs.appendChar('g');
    expect(hs.query).toBe('g');
    expect(hs.matches.length).toBeGreaterThan(0);

    hs.appendChar('i');
    expect(hs.query).toBe('gi');
  });

  test('appendChar() narrows results incrementally', () => {
    hs.appendChar('g');
    const afterG = hs.matches.length;
    hs.appendChar('i');
    hs.appendChar('t');
    hs.appendChar(' ');
    hs.appendChar('c');
    const afterGitC = hs.matches.length;
    expect(afterGitC).toBeLessThanOrEqual(afterG);
    expect(hs.matches[0]?.entry).toBe('git commit');
  });

  test('deleteChar() shortens query', () => {
    hs.appendChar('g');
    hs.appendChar('i');
    hs.appendChar('t');
    expect(hs.query).toBe('git');
    hs.deleteChar();
    expect(hs.query).toBe('gi');
  });

  test('deleteChar() on empty query does nothing', () => {
    hs.deleteChar();
    expect(hs.query).toBe('');
    expect(hs.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stepOlder() / stepNewer() boundary conditions
// ---------------------------------------------------------------------------

describe('HistorySearch: stepOlder() / stepNewer()', () => {
  let hs: HistorySearch;

  beforeEach(() => {
    hs = makeSearch(['git alpha', 'git beta', 'git gamma']);
    hs.open('');
    hs.search('git');
    // matches: [alpha, beta, gamma] at indices 0, 1, 2
  });

  test('starts at matchIndex 0', () => {
    expect(hs.matchIndex).toBe(0);
  });

  test('stepOlder() advances matchIndex', () => {
    hs.stepOlder();
    expect(hs.matchIndex).toBe(1);
    hs.stepOlder();
    expect(hs.matchIndex).toBe(2);
  });

  test('stepOlder() stops at last match (no wraparound)', () => {
    hs.stepOlder();
    hs.stepOlder(); // now at 2 (last)
    hs.stepOlder(); // should stay at 2
    expect(hs.matchIndex).toBe(2);
  });

  test('stepNewer() decrements matchIndex', () => {
    hs.stepOlder();
    hs.stepOlder(); // at 2
    hs.stepNewer();
    expect(hs.matchIndex).toBe(1);
  });

  test('stepNewer() stops at 0 (no wraparound)', () => {
    expect(hs.matchIndex).toBe(0);
    hs.stepNewer(); // already at 0, should stay
    expect(hs.matchIndex).toBe(0);
  });

  test('stepOlder() does nothing when no matches', () => {
    const empty = makeSearch([]);
    empty.open('');
    empty.search('nothing');
    empty.stepOlder();
    expect(empty.matchIndex).toBe(0);
  });

  test('currentMatch reflects matchIndex', () => {
    expect(hs.currentMatch?.entry).toBe('git alpha');
    hs.stepOlder();
    expect(hs.currentMatch?.entry).toBe('git beta');
    hs.stepOlder();
    expect(hs.currentMatch?.entry).toBe('git gamma');
  });

  test('currentMatch is null when no matches', () => {
    const empty = makeSearch([]);
    empty.open('');
    expect(empty.currentMatch).toBeNull();
  });
});
