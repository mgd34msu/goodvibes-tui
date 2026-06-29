import { describe, expect, test } from 'bun:test';
import { renderPanelTabBar } from '../../renderer/panel-tab-bar.ts';
import { renderPanelWorkspaceBar } from '../../renderer/panel-workspace-bar.ts';
import { renderPanelPickerOverlay } from '../../renderer/panel-picker-overlay.ts';
import { PanelPicker } from '../../panels/panel-picker.ts';
import type { Panel } from '../../panels/types.ts';
import type { PanelRegistration } from '../../panels/types.ts';
import type { WorkspaceTab } from '../../panels/panel-manager.ts';
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
    invalidate() { this.needsRender = true; },
    markRendered() { this.needsRender = false; },
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

  test('workspace bar renders open tabs across panes', () => {
    const tabs: WorkspaceTab[] = [
      { id: 'system', name: 'System Messages', icon: 'J', pane: 'top', active: true, focused: true },
      { id: 'wrfc', name: 'WRFC', icon: 'W', pane: 'bottom', active: false, focused: false },
    ];
    const line = renderPanelWorkspaceBar(tabs, 100, true);
    const text = lineToString(line);
    expect(text).toContain('PANELS');
    expect(text).toContain('^ J System Messages');
    expect(text).toContain('v W WRFC');
  });

  test('tab bar renders error glyph for panel with status bad', () => {
    const errorPanel: Panel = {
      ...makePanel('err', 'ErrorPanel'),
      getTabStatus() { return 'bad' as const; },
    };
    const line = renderPanelTabBar(
      [makePanel('ok', 'OkPanel'), errorPanel],
      0,
      120,
      true,
    );
    const text = lineToString(line);
    expect(text).toContain('✕'); // bad glyph ✕
  });

  test('tab without status renders without any status glyph', () => {
    const panels = [makePanel('a', 'Alpha'), makePanel('b', 'Beta')];
    const line = renderPanelTabBar(panels, 0, 80, true, 'top');
    const text = lineToString(line);
    expect(text).not.toContain('✕'); // no bad glyph
    expect(text).not.toContain('⚠'); // no warn glyph
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
  });

  test('workspace bar shows error glyph for tab with status bad', () => {
    const tabs: WorkspaceTab[] = [
      { id: 'sys', name: 'System', icon: 'J', pane: 'top', active: true, focused: true, status: 'bad' },
      { id: 'clean', name: 'Clean', icon: 'W', pane: 'bottom', active: false, focused: false },
    ];
    const line = renderPanelWorkspaceBar(tabs, 120, true);
    const text = lineToString(line);
    expect(text).toContain('✕'); // bad status glyph
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
