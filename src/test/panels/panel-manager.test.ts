import { describe, expect, mock, test } from 'bun:test';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { Panel } from '../../panels/types.ts';

function makePanel(id: string, name = id): Panel & {
  readonly activate: ReturnType<typeof mock>;
  readonly deactivate: ReturnType<typeof mock>;
  readonly destroy: ReturnType<typeof mock>;
} {
  const activate = mock(() => {});
  const deactivate = mock(() => {});
  const destroy = mock(() => {});
  return {
    id,
    name,
    icon: id[0]?.toUpperCase() ?? 'X',
    category: 'monitoring',
    isTransient: false,
    isPinned: false,
    needsRender: true,
    onActivate: activate,
    onDeactivate: deactivate,
    onDestroy: destroy,
    render: () => [],
    activate,
    deactivate,
    destroy,
  };
}

describe('PanelManager', () => {
  test('preloaded panels are retained across close and reused on reopen', () => {
    const manager = new PanelManager();
    const panel = makePanel('system-messages', 'System Messages');

    manager.registerType({
      id: 'system-messages',
      name: 'System Messages',
      icon: 'J',
      category: 'monitoring',
      description: 'System traffic',
      preload: true,
      factory: () => panel,
    });

    manager.prewarmRegistered();
    const opened = manager.open('system-messages');
    manager.close('system-messages');
    const reopened = manager.open('system-messages');

    expect(opened).toBe(panel);
    expect(reopened).toBe(panel);
    expect(panel.destroy).not.toHaveBeenCalled();
    expect(panel.activate).toHaveBeenCalledTimes(2);
  });

  test('workspace tab navigation cycles across panes', () => {
    const manager = new PanelManager();
    const topPanel = makePanel('system-messages', 'System Messages');
    const bottomPanel = makePanel('wrfc', 'WRFC');

    manager.registerType({
      id: 'system-messages',
      name: 'System Messages',
      icon: 'J',
      category: 'monitoring',
      description: 'System traffic',
      factory: () => topPanel,
    });
    manager.registerType({
      id: 'wrfc',
      name: 'WRFC',
      icon: 'W',
      category: 'agent',
      description: 'Workflow review',
      factory: () => bottomPanel,
    });

    manager.open('system-messages', 'top');
    manager.open('wrfc', 'bottom');

    expect(manager.getFocusedPane()).toBe('bottom');
    expect(manager.getActivePanel()?.id).toBe('wrfc');

    manager.prevWorkspaceTab();
    expect(manager.getFocusedPane()).toBe('top');
    expect(manager.getActivePanel()?.id).toBe('system-messages');

    manager.nextWorkspaceTab();
    expect(manager.getFocusedPane()).toBe('bottom');
    expect(manager.getActivePanel()?.id).toBe('wrfc');
  });
});
