// ---------------------------------------------------------------------------
// scrollable-list-panel-i5.test.ts — I5: selection gutter + filter input line
//
// Tests the opt-in showSelectionGutter flag and the buildFilterLine helper
// on ScrollableListPanel (SearchableListPanel was deleted once its
// last subclasses — skills, memory — converged onto ScrollableListPanel's
// modal '/' filter; this file now exercises that shared contract directly).
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { ScrollableListPanel } from '../../panels/scrollable-list-panel.ts';

// ---------------------------------------------------------------------------
// Minimal concrete subclass of ScrollableListPanel for gutter + filter tests
// ---------------------------------------------------------------------------

class TestScrollablePanel extends ScrollableListPanel<string> {
  private _items: string[];

  constructor(items: string[], gutter = false) {
    super('test', 'Test', 'T', 'runtime-ops');
    this._items = items;
    this.showSelectionGutter = gutter;
  }

  protected getItems(): readonly string[] {
    return this._items;
  }

  protected filterMatches(item: string, q: string): boolean {
    return item.toLowerCase().includes(q);
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

  // Expose the opt-in filter fields for direct manipulation in tests.
  public setFilterEnabled(enabled: boolean): void {
    this.filterEnabled = enabled;
  }

  public setFilterLabel(label: string): void {
    this.filterLabel = label;
  }

  public setFilterActive(active: boolean): void {
    this.filterActive = active;
  }

  public setFilterQuery(q: string): void {
    this.filterQuery = q;
  }

  // Expose buildFilterLine for testing (pinned rendering contract).
  public exposeBuildFilterLine(width: number): Line {
    return this.buildFilterLine(width);
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
// ScrollableListPanel — buildFilterLine (I5, converged modal filter)
//
// This is the single pinned rendering contract every filterable list panel
// shares: 'Filter: ' unfocused / '[Filter] ' focused, literal trailing '_'
// cursor while active.
// ---------------------------------------------------------------------------

describe('ScrollableListPanel — buildFilterLine (I5)', () => {
  const WIDTH = 40;
  let panel: TestScrollablePanel;

  beforeEach(() => {
    panel = new TestScrollablePanel(['apple', 'banana', 'cherry']);
    panel.setFilterEnabled(true);
    panel.setFilterLabel('Filter');
  });

  test('unfocused: label is "Filter: "', () => {
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).toContain('Filter: ');
    expect(text).not.toContain('[Filter]');
  });

  test('focused: label is "[Filter] "', () => {
    panel.setFilterActive(true);
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).toContain('[Filter] ');
    expect(text).not.toContain('Filter: ');
  });

  test('focused: appends _ cursor to query', () => {
    panel.setFilterActive(true);
    panel.setFilterQuery('ap');
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).toContain('ap_');
  });

  test('unfocused: no _ cursor appended', () => {
    panel.setFilterQuery('ap');
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).not.toContain('ap_');
    expect(text).toContain('ap');
  });

  test('empty query unfocused: shows the "/ to filter" placeholder', () => {
    panel.setFilterQuery('');
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).toContain('/ to filter');
    expect(line.length).toBe(WIDTH);
  });

  test('custom label used in unfocused', () => {
    panel.setFilterLabel('Search');
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).toContain('Search: ');
  });

  test('custom label used in focused', () => {
    panel.setFilterLabel('Search');
    panel.setFilterActive(true);
    const line = panel.exposeBuildFilterLine(WIDTH);
    const text = lineText(line);
    expect(text).toContain('[Search] ');
  });

  test('line is always exactly WIDTH cells', () => {
    panel.setFilterActive(true);
    const focusedLine = panel.exposeBuildFilterLine(WIDTH);
    panel.setFilterActive(false);
    const unfocusedLine = panel.exposeBuildFilterLine(WIDTH);
    expect(focusedLine.length).toBe(WIDTH);
    expect(unfocusedLine.length).toBe(WIDTH);
  });
});
