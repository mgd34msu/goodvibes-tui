import { describe, expect, test } from 'bun:test';
import { renderPanelWorkspaceBar } from '../../renderer/panel-workspace-bar.ts';
import type { WorkspaceTab } from '../../panels/panel-manager.ts';
import { lineToString } from '../setup.ts';

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
});
