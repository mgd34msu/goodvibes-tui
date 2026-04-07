import { describe, expect, test } from 'bun:test';
import { renderPanelTabBar } from '../../renderer/panel-tab-bar.ts';
import { renderPanelPickerOverlay } from '../../renderer/panel-picker-overlay.ts';
import { PanelPicker } from '../../panels/panel-picker.ts';
import type { Panel } from '../../panels/types.ts';
import type { PanelRegistration } from '../../panels/types.ts';
import { lineToString, linesToText } from '../setup.ts';

function makePanel(id: string, name: string, icon = 'X'): Panel {
  return {
    id,
    name,
    icon,
    category: 'monitoring',
    isTransient: false,
    isPinned: false,
    needsRender: true,
    onActivate() {},
    onDeactivate() {},
    onDestroy() {},
    render: () => [],
  };
}

function makeRegistration(id: string, name: string, category: PanelRegistration['category'], description: string): PanelRegistration {
  return {
    id,
    name,
    icon: name[0] ?? 'X',
    category,
    description,
    factory: () => makePanel(id, name),
  };
}

describe('panel navigation chrome', () => {
  test('tab bar renders pane label and panel count', () => {
    const line = renderPanelTabBar(
      [makePanel('a', 'Alpha'), makePanel('b', 'Beta')],
      0,
      80,
      true,
      'top',
    );
    const text = lineToString(line);
    expect(text).toContain('TOP');
    expect(text).toContain('2');
    expect(text).toContain('Alpha');
  });

  test('panel picker renders selected panel detail block', () => {
    const picker = new PanelPicker();
    picker.open([
      makeRegistration('cockpit', 'Cockpit', 'monitoring', 'Unified operator cockpit'),
      makeRegistration('git', 'Git', 'development', 'Git status and branch review'),
    ]);
    picker.moveDown();
    const lines = renderPanelPickerOverlay(picker, 100);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Open Panel Workspace');
    expect(text).toContain('Cockpit');
    expect(text).toContain('[MONITORING]');
    expect(text).toContain('Unified operator cockpit');
  });
});
