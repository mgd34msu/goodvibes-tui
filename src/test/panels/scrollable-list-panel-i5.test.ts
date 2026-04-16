// ---------------------------------------------------------------------------
// scrollable-list-panel-i5.test.ts — I5: selection gutter + filter input line
//
// Tests the opt-in showSelectionGutter flag on ScrollableListPanel and the
// buildFilterInputLine helper on SearchableListPanel.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import type { Line } from '../../types/grid.ts';
import { createEmptyLine } from '../../types/grid.ts';
import {
  ScrollableListPanel,
  SearchableListPanel,
} from '../../panels/scrollable-list-panel.ts';
import { DEFAULT_PANEL_PALETTE } from '../../panels/polish.ts';

// ---------------------------------------------------------------------------
// Minimal concrete subclass of ScrollableListPanel for gutter tests
// ---------------------------------------------------------------------------

class TestScrollablePanel extends ScrollableListPanel<string> {
  private _items: string[];

  constructor(items: string[], gutter = false) {
    super('test', 'Test', 'T', 'monitoring');
    this._items = items;
    this.showSelectionGutter = gutter;
  }

  protected getItems(): readonly string[] {
    return this._items;
  }

  protected renderItem(item: string, _index: number, _selected: boolean, width: number): Line {
    const line = createEmptyLine(width);
    // Fill with the item text chars
    for (let i = 0; i < item.length && i < width; i++) {
      line[i] = { char: item[i]!, fg: '#fff', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    }
    return line;
  }

  // Expose selection index for tests
  public setSelectedIndex(i: number): void {
    this.selectedIndex = i;
  }

  public render(width: number, height: number): Line[] {
    return this.renderList(width, height);
  }
}

// ---------------------------------------------------------------------------
// Minimal concrete subclass of SearchableListPanel for filter line tests
// ---------------------------------------------------------------------------

class TestSearchablePanel extends SearchableListPanel<string> {
  private _allItems: string[];

  constructor(items: string[]) {
    super('test-s', 'TestS', 'S', 'monitoring');
    this._allItems = items;
  }

  protected getAllItems(): readonly string[] {
    return this._allItems;
  }

  protected matchesSearch(item: string, query: string): boolean {
    return item.toLowerCase().includes(query.toLowerCase());
  }

  protected renderItem(item: string, _index: number, _selected: boolean, width: number): Line {
    const line = createEmptyLine(width);
    for (let i = 0; i < item.length && i < width; i++) {
      line[i] = { char: item[i]!, fg: '#fff', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    }
    return line;
  }

  // Expose buildFilterInputLine for testing
  public exposeBuildFilterInputLine(width: number, label: string, focused: boolean): Line {
    return this.buildFilterInputLine(width, label, focused);
  }

  // Set searchQuery directly for tests
  public setSearchQuery(q: string): void {
    this.searchQuery = q;
  }

  public render(width: number, height: number): Line[] {
    return this.renderList(width, height);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineText(line: Line): string {
  return line.map((cell) => cell.char).join('');
}

// ---------------------------------------------------------------------------
// ScrollableListPanel — showSelectionGutter
// ---------------------------------------------------------------------------

describe('ScrollableListPanel — showSelectionGutter (I5)', () => {
  const WIDTH = 20;
  const HEIGHT = 10;

  test('showSelectionGutter defaults to false', () => {
    const panel = new TestScrollablePanel(['alpha', 'beta'], false);
    // Without gutter, rendered item text should start at column 0
    const lines = panel.render(WIDTH, HEIGHT);
    // Find the first content line after the workspace title
    const contentLines = lines.filter((l) => l[0]?.char !== ' ' || l[1]?.char !== ' ');
    // The gutter-off panel should NOT have ▸ anywhere in col0
    const hasGlyphInCol0 = lines.some((l) => l[0]?.char === '\u25b8');
    expect(hasGlyphInCol0).toBe(false);
  });

  test('showSelectionGutter=true puts \u25b8 in col0 of selected row', () => {
    const panel = new TestScrollablePanel(['alpha', 'beta', 'gamma'], true);
    panel.setSelectedIndex(0);
    const lines = panel.render(WIDTH, HEIGHT);
    const hasGlyph = lines.some((l) => l[0]?.char === '\u25b8');
    expect(hasGlyph).toBe(true);
  });

  test('gutter: unselected rows have space in col0', () => {
    const panel = new TestScrollablePanel(['alpha', 'beta', 'gamma'], true);
    panel.setSelectedIndex(1); // only row 1 is selected
    const lines = panel.render(WIDTH, HEIGHT);
    // Rows with 'alpha' and 'gamma' content should have ' ' in col0
    // Row col2 onwards should have the item char for unselected rows
    const alphaLine = lines.find((l) => {
      // Look for line where col2 onwards spells 'alpha'
      return l[2]?.char === 'a' && l[3]?.char === 'l';
    });
    expect(alphaLine).toBeDefined();
    expect(alphaLine![0]?.char).toBe(' ');
    expect(alphaLine![1]?.char).toBe(' ');
  });

  test('gutter: selected row has \u25b8 in col0', () => {
    const panel = new TestScrollablePanel(['alpha', 'beta', 'gamma'], true);
    panel.setSelectedIndex(1); // 'beta' is selected
    const lines = panel.render(WIDTH, HEIGHT);
    // Find line where col2 onwards spells 'beta'
    const betaLine = lines.find((l) => l[2]?.char === 'b' && l[3]?.char === 'e');
    expect(betaLine).toBeDefined();
    expect(betaLine![0]?.char).toBe('\u25b8');
    expect(betaLine![1]?.char).toBe(' ');
  });

  test('gutter: line width is preserved (still = WIDTH)', () => {
    const panel = new TestScrollablePanel(['hello'], true);
    panel.setSelectedIndex(0);
    const lines = panel.render(WIDTH, HEIGHT);
    for (const line of lines) {
      expect(line.length).toBe(WIDTH);
    }
  });

  test('gutter disabled: no column shift, item text at col0 in item lines', () => {
    const panel = new TestScrollablePanel(['hello'], false);
    panel.setSelectedIndex(0);
    const lines = panel.render(WIDTH, HEIGHT);
    // Find the content line that starts with 'h'
    const helloLine = lines.find((l) => l[0]?.char === 'h');
    expect(helloLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SearchableListPanel — buildFilterInputLine
// ---------------------------------------------------------------------------

describe('SearchableListPanel — buildFilterInputLine (I5)', () => {
  const WIDTH = 40;
  let panel: TestSearchablePanel;

  beforeEach(() => {
    panel = new TestSearchablePanel(['apple', 'banana', 'cherry']);
  });

  test('unfocused: label is "Filter: "', () => {
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', false);
    const text = lineText(line);
    expect(text).toContain('Filter: ');
    expect(text).not.toContain('[Filter]');
  });

  test('focused: label is "[Filter] "', () => {
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', true);
    const text = lineText(line);
    expect(text).toContain('[Filter] ');
    expect(text).not.toContain('Filter: ');
  });

  test('focused: appends _ cursor to query', () => {
    panel.setSearchQuery('ap');
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', true);
    const text = lineText(line);
    expect(text).toContain('ap_');
  });

  test('unfocused: no _ cursor appended', () => {
    panel.setSearchQuery('ap');
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', false);
    const text = lineText(line);
    expect(text).not.toContain('ap_');
    expect(text).toContain('ap');
  });

  test('empty query unfocused: shows (none) or empty', () => {
    panel.setSearchQuery('');
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', false);
    expect(line.length).toBe(WIDTH);
  });

  test('custom label used in unfocused', () => {
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Search', false);
    const text = lineText(line);
    expect(text).toContain('Search: ');
  });

  test('custom label used in focused', () => {
    const line = panel.exposeBuildFilterInputLine(WIDTH, 'Search', true);
    const text = lineText(line);
    expect(text).toContain('[Search] ');
  });

  test('line is always exactly WIDTH cells', () => {
    const focusedLine = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', true);
    const unfocusedLine = panel.exposeBuildFilterInputLine(WIDTH, 'Filter', false);
    expect(focusedLine.length).toBe(WIDTH);
    expect(unfocusedLine.length).toBe(WIDTH);
  });
});
