import { describe, expect, test } from 'bun:test';
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
