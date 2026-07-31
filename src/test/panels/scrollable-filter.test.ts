import { describe, test, expect } from 'bun:test';
import { ScrollableListPanel } from '../../panels/scrollable-list-panel.ts';
import { buildPanelLine, DEFAULT_PANEL_PALETTE } from '../../panels/polish.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { linesToText } from '../setup.ts';

class FilterDemo extends ScrollableListPanel<string> {
  public opened: string | null = null;
  constructor() {
    super('demo', 'Demo', 'D', 'development');
    this.filterEnabled = true;
    this.filterLabel = 'Filter items';
    this.showSelectionGutter = true;
  }
  protected getItems(): readonly string[] {
    return ['alpha', 'beta', 'gamma', 'delta'];
  }
  protected filterMatches(item: string, q: string): boolean {
    return item.toLowerCase().includes(q);
  }
  protected renderItem(item: string, _i: number, _sel: boolean, width: number): Line {
    return buildPanelLine(width, [[item, DEFAULT_PANEL_PALETTE.value]]);
  }
  public render(width: number, height: number): Line[] {
    return this.renderList(width, height);
  }
  // single-letter action key must still work outside filter mode
  public override handleInput(key: string): boolean {
    if (!this.filterActive && key === 'o') { this.opened = this.getVisibleItems()[this.selectedIndex] ?? null; return true; }
    return super.handleInput(key);
  }
}

describe('ScrollableListPanel opt-in filter', () => {
  test('"/" enters filter mode and typing narrows the visible list', () => {
    const p = new FilterDemo();
    expect(p.handleInput('/')).toBe(true);
    for (const ch of 'lph') p.handleInput(ch); // matches only "alpha"
    const text = linesToText(p.render(60, 14)).join('\n');
    expect(text).toContain('alpha');
    expect(text).not.toContain('beta');
    expect(text).not.toContain('gamma');
    expect(text).not.toContain('delta');
  });

  test('filter matches are substring, case-insensitive', () => {
    const p = new FilterDemo();
    p.handleInput('/');
    for (const ch of 'GA') p.handleInput(ch.toLowerCase());
    const text = linesToText(p.render(60, 14)).join('\n');
    expect(text).toContain('gamma');
    expect(text).not.toContain('alpha');
    expect(text).not.toContain('delta');
  });

  test('Escape clears the filter and restores the full list', () => {
    const p = new FilterDemo();
    p.handleInput('/');
    p.handleInput('z'); // no matches
    let text = linesToText(p.render(60, 14)).join('\n');
    expect(text).toContain('No matches');
    p.handleInput('escape');
    text = linesToText(p.render(60, 14)).join('\n');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });

  test('single-letter action keys work outside filter mode but type into the query inside it', () => {
    const p = new FilterDemo();
    // outside filter mode: 'o' triggers the action
    p.handleInput('o');
    expect(p.opened).toBe('alpha');
    // inside filter mode: 'o' becomes query text
    p.opened = null;
    p.handleInput('/');
    p.handleInput('o');
    expect(p.opened).toBeNull();
    expect((p as unknown as { filterQuery: string }).filterQuery).toBe('o');
  });

  test('filter line renders the affordance', () => {
    const p = new FilterDemo();
    const idle = linesToText(p.render(60, 14)).join('\n');
    expect(idle).toContain('/ to filter');
    p.handleInput('/');
    const active = linesToText(p.render(60, 14)).join('\n');
    expect(active).toContain('Filter items');
  });
});
