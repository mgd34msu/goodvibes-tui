import { describe, expect, test } from 'bun:test';
import { renderSearchOverlay } from '../../renderer/search-overlay.ts';
import { SearchManager } from '../../input/search.ts';

/** Extract text from a rendered Line (Cell array). */
function lineText(line: import('@pellux/goodvibes-sdk/platform/types').Line): string {
  return line.map(c => c.char).join('');
}

describe('renderSearchOverlay', () => {
  test('handles wide-character queries and keeps exact line width', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.query = '界\u{1F642}needle';
    manager.matches = [{ line: 0, col: 2, length: 8 }];
    manager.currentMatch = 0;

    const width = 80;
    const lines = renderSearchOverlay(manager, width);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBe(width);
  });

  test('returns exactly one line for any width', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.query = 'hello';
    manager.matches = [{ line: 0, col: 0, length: 5 }];
    manager.currentMatch = 0;

    for (const width of [40, 80, 120]) {
      const lines = renderSearchOverlay(manager, width);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.length).toBe(width);
    }
  });

  test('match count indicator shows N/M format', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.locked = true;
    manager.query = 'hello';
    manager.matches = [
      { line: 0, col: 0, length: 5 },
      { line: 1, col: 0, length: 5 },
      { line: 2, col: 0, length: 5 },
    ];
    manager.currentMatch = 1;

    const lines = renderSearchOverlay(manager, 80);
    const text = lineText(lines[0]!);
    expect(text).toContain('2/3');
  });

  test('zero-match state says No matches', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.query = 'zzznomatch';
    manager.matches = [];
    manager.currentMatch = 0;

    const lines = renderSearchOverlay(manager, 80);
    const text = lineText(lines[0]!);
    expect(text).toContain('No matches');
  });

  test('empty query shows no count and no No matches', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.query = '';
    manager.matches = [];
    manager.currentMatch = 0;

    const lines = renderSearchOverlay(manager, 80);
    const text = lineText(lines[0]!);
    expect(text).not.toContain('No matches');
    expect(text).not.toMatch(/\d+\/\d+/);
  });

  test('wrap notice appended to count when wrapAround is true', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.locked = true;
    manager.query = 'abc';
    manager.matches = [
      { line: 0, col: 0, length: 3 },
      { line: 1, col: 0, length: 3 },
    ];
    manager.currentMatch = 0;
    manager.wrapAround = true;

    const lines = renderSearchOverlay(manager, 80);
    const text = lineText(lines[0]!);
    expect(text).toContain('(wrap)');
  });

  test('no wrap notice when wrapAround is false', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.locked = true;
    manager.query = 'abc';
    manager.matches = [{ line: 0, col: 0, length: 3 }];
    manager.currentMatch = 0;
    manager.wrapAround = false;

    const lines = renderSearchOverlay(manager, 80);
    const text = lineText(lines[0]!);
    expect(text).not.toContain('(wrap)');
  });

  test('hints mention n/N in locked mode', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.locked = true;
    manager.query = 'foo';
    manager.matches = [{ line: 0, col: 0, length: 3 }];
    manager.currentMatch = 0;

    const lines = renderSearchOverlay(manager, 100);
    const text = lineText(lines[0]!);
    expect(text).toContain('n/N');
  });
});
