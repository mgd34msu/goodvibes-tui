import { describe, expect, test } from 'bun:test';
import { renderSearchOverlay } from '../../renderer/search-overlay.ts';
import { SearchManager } from '../../input/search.ts';

describe('renderSearchOverlay', () => {
  test('handles wide-character queries and keeps exact line width', () => {
    const manager = new SearchManager();
    manager.active = true;
    manager.query = '界🙂needle';
    manager.matches = [{ line: 0, col: 2, length: 8 }];
    manager.currentMatch = 0;

    const width = 80;
    const lines = renderSearchOverlay(manager, width);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBe(width);
  });
});
