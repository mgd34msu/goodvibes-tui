import { describe, expect, test } from 'bun:test';
import { ExpandableListPanel } from '../../panels/expandable-list-panel.ts';
import { buildPanelLine, DEFAULT_PANEL_PALETTE } from '../../panels/polish.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { linesToText } from '../setup.ts';

class DemoPanel extends ExpandableListPanel<string> {
  constructor() {
    super('demo', 'Demo', 'D', 'development');
    this.showSelectionGutter = true;
  }
  protected getItems(): readonly string[] {
    return ['alpha', 'beta', 'gamma'];
  }
  protected renderItem(item: string, _i: number, _sel: boolean, width: number): Line {
    return buildPanelLine(width, [[item, DEFAULT_PANEL_PALETTE.value]]);
  }
  protected getDetailLines(item: string, width: number): readonly Line[] {
    return [buildPanelLine(width, [[`DETAIL:${item}`, DEFAULT_PANEL_PALETTE.value]])];
  }
}

describe('ExpandableListPanel', () => {
  test('starts in list mode and shows items', () => {
    const panel = new DemoPanel();
    const text = linesToText(panel.render(60, 12)).join('\n');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).not.toContain('DETAIL:');
  });

  test('Enter expands the selected item into the detail view', () => {
    const panel = new DemoPanel();
    panel.handleInput('down'); // select beta
    panel.handleInput('enter');
    const text = linesToText(panel.render(60, 12)).join('\n');
    expect(text).toContain('DETAIL:beta');
    expect(text).toContain('back'); // detail hints footer
  });

  test('Escape returns to the list', () => {
    const panel = new DemoPanel();
    panel.handleInput('enter');
    expect(linesToText(panel.render(60, 12)).join('\n')).toContain('DETAIL:alpha');
    panel.handleInput('escape');
    const text = linesToText(panel.render(60, 12)).join('\n');
    expect(text).not.toContain('DETAIL:');
    expect(text).toContain('alpha');
  });

  test('detail scroll keys are consumed in detail mode only', () => {
    const panel = new DemoPanel();
    expect(panel.handleInput('down')).toBe(true); // list nav
    panel.handleInput('enter');
    expect(panel.handleInput('down')).toBe(true); // detail scroll
    panel.handleInput('escape');
    // back in list mode
    expect(panel.handleInput('left')).toBe(false); // left not used in list mode
  });
});
