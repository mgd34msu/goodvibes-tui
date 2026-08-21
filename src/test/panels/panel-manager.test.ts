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
    category: 'runtime-ops',
    isTransient: false,
    isPinned: false,
    needsRender: true,
    onActivate: activate,
    onDeactivate: deactivate,
    onDestroy: destroy,
    render: () => [],
    invalidate() { this.needsRender = true; },
    markRendered() { this.needsRender = false; },
    activate,
    deactivate,
    destroy,
  };
}

describe('PanelManager', () => {
  test('preloaded + retainOnClose panels are retained across close and reused on reopen', () => {
    const manager = new PanelManager();
    const panel = makePanel('system-messages', 'System Messages');

    manager.registerType({
      id: 'system-messages',
      name: 'System Messages',
      icon: 'J',
      category: 'runtime-ops',
      description: 'System traffic',
      preload: true,
      retainOnClose: true,
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

  test('preload and retainOnClose are independent lifecycle flags', () => {
    // preload without retainOnClose: eagerly instantiated, but destroyed on close.
    const preloadOnlyManager = new PanelManager();
    const preloadOnlyPanel = makePanel('preload-only', 'Preload Only');
    preloadOnlyManager.registerType({
      id: 'preload-only',
      name: 'Preload Only',
      icon: 'A',
      category: 'runtime-ops',
      description: '',
      preload: true,
      factory: () => preloadOnlyPanel,
    });
    preloadOnlyManager.prewarmRegistered();
    preloadOnlyManager.open('preload-only');
    preloadOnlyManager.close('preload-only');
    expect(preloadOnlyPanel.destroy).toHaveBeenCalledTimes(1);

    // retainOnClose without preload: lazily instantiated on first open, but
    // kept alive (not destroyed) across a subsequent close.
    const retainOnlyManager = new PanelManager();
    const retainOnlyPanel = makePanel('retain-only', 'Retain Only');
    retainOnlyManager.registerType({
      id: 'retain-only',
      name: 'Retain Only',
      icon: 'B',
      category: 'runtime-ops',
      description: '',
      retainOnClose: true,
      factory: () => retainOnlyPanel,
    });
    retainOnlyManager.prewarmRegistered(); // no-op: not preload
    retainOnlyManager.open('retain-only');
    retainOnlyManager.close('retain-only');
    expect(retainOnlyPanel.destroy).not.toHaveBeenCalled();
    const reopenedRetainOnly = retainOnlyManager.open('retain-only');
    expect(reopenedRetainOnly).toBe(retainOnlyPanel);
  });

  test('registerType asserts icon uniqueness across the registry', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'panel-a', name: 'A', icon: 'Z', category: 'runtime-ops', description: '', factory: () => makePanel('panel-a', 'A') });
    expect(() => {
      manager.registerType({ id: 'panel-b', name: 'B', icon: 'Z', category: 'runtime-ops', description: '', factory: () => makePanel('panel-b', 'B') });
    }).toThrow();

    // Re-registering the SAME id with the same icon is a legitimate update,
    // not a collision (tests and hot-reload paths replace factories in place).
    expect(() => {
      manager.registerType({ id: 'panel-a', name: 'A2', icon: 'Z', category: 'runtime-ops', description: '', factory: () => makePanel('panel-a', 'A2') });
    }).not.toThrow();
  });

  test('workspace tab navigation cycles across panes', () => {
    const manager = new PanelManager();
    const topPanel = makePanel('system-messages', 'System Messages');
    const bottomPanel = makePanel('wrfc', 'WRFC');

    manager.registerType({
      id: 'system-messages',
      name: 'System Messages',
      icon: 'J',
      category: 'runtime-ops',
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

  test('getWorkspaceTabs active is per-pane-independent of keyboard focus', () => {
    // Open A (top), B (top second), C (bottom).
    // Activate B in top pane. Focus top. Then switch focus to bottom.
    // B must remain active=true even after focus moves to bottom.
    const manager = new PanelManager();
    const panelA = makePanel('panel-a', 'A');
    const panelB = makePanel('panel-b', 'B');
    const panelC = makePanel('panel-c', 'C');

    manager.registerType({ id: 'panel-a', name: 'A', icon: 'A', category: 'runtime-ops', description: '', factory: () => panelA });
    manager.registerType({ id: 'panel-b', name: 'B', icon: 'B', category: 'runtime-ops', description: '', factory: () => panelB });
    manager.registerType({ id: 'panel-c', name: 'C', icon: 'C', category: 'runtime-ops', description: '', factory: () => panelC });

    manager.open('panel-a', 'top');
    manager.open('panel-b', 'top');
    manager.open('panel-c', 'bottom');

    // After opening panel-b last in top pane, it should be active there.
    // Focus top pane explicitly.
    manager.focusPane('top');

    const tabsTopFocused = manager.getWorkspaceTabs();
    const tabA = tabsTopFocused.find((t) => t.id === 'panel-a')!;
    const tabB = tabsTopFocused.find((t) => t.id === 'panel-b')!;
    const tabC = tabsTopFocused.find((t) => t.id === 'panel-c')!;

    // B is active in top pane (last opened there), has keyboard focus.
    expect(tabB.active).toBe(true);
    expect(tabB.focused).toBe(true);
    // C is active in its own pane (only panel there), but NOT focused.
    expect(tabC.active).toBe(true);
    expect(tabC.focused).toBe(false);
    // A is in top pane but not the active one.
    expect(tabA.active).toBe(false);
    expect(tabA.focused).toBe(false);

    // Move focus to bottom pane.
    manager.focusPane('bottom');
    const tabsBottomFocused = manager.getWorkspaceTabs();
    const tabBAfter = tabsBottomFocused.find((t) => t.id === 'panel-b')!;
    const tabCAfter = tabsBottomFocused.find((t) => t.id === 'panel-c')!;

    // B stays active (still selected in top pane) but loses focused.
    expect(tabBAfter.active).toBe(true);
    expect(tabBAfter.focused).toBe(false);
    // C gains focused (it's the active panel in the now-focused bottom pane).
    expect(tabCAfter.active).toBe(true);
    expect(tabCAfter.focused).toBe(true);
  });

  test('focus ownership: workspace focus can never disagree with visibility', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'panel-a', name: 'A', icon: 'A', category: 'runtime-ops', description: '', factory: () => makePanel('panel-a', 'A') });
    manager.registerType({ id: 'panel-b', name: 'B', icon: 'B', category: 'runtime-ops', description: '', factory: () => makePanel('panel-b', 'B') });

    // The invariant: focus may only rest on the panel workspace while the
    // workspace is actually on screen with an active panel.
    const assertInvariant = () => {
      if (manager.getFocusTarget() === 'panel') {
        expect(manager.isVisible()).toBe(true);
        expect(manager.getAllOpen().length).toBeGreaterThan(0);
        expect(manager.getActivePanel()).not.toBeNull();
      }
    };

    // Fresh manager: focus is on the prompt.
    expect(manager.getFocusTarget()).toBe('prompt');

    // focusPanels with nothing open cannot steal focus.
    manager.focusPanels();
    expect(manager.getFocusTarget()).toBe('prompt');
    assertInvariant();

    // Open a panel and focus the workspace.
    manager.open('panel-a', 'top');
    manager.focusPanels();
    expect(manager.getFocusTarget()).toBe('panel');
    assertInvariant();

    // Closing the last panel must drop focus back to the prompt automatically.
    manager.close('panel-a');
    expect(manager.getFocusTarget()).toBe('prompt');
    assertInvariant();

    // Two panels across both panes, focused, then close-all.
    manager.open('panel-a', 'top');
    manager.open('panel-b', 'bottom');
    manager.focusPanels();
    expect(manager.getFocusTarget()).toBe('panel');
    assertInvariant();
    for (const p of manager.getAllOpen()) manager.close(p.id);
    expect(manager.getFocusTarget()).toBe('prompt');
    assertInvariant();

    // Hiding the workspace while a panel is retained also heals focus.
    manager.open('panel-a', 'top');
    manager.focusPanels();
    expect(manager.getFocusTarget()).toBe('panel');
    manager.hide();
    expect(manager.getFocusTarget()).toBe('prompt');
    assertInvariant();
  });

  test('open(id, pane) honors the requested pane by relocating an already-open panel', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'panel-a', name: 'A', icon: 'A', category: 'runtime-ops', description: '', factory: () => makePanel('panel-a', 'A') });

    manager.open('panel-a', 'top');
    expect(manager.getPaneOf('panel-a')).toBe('top');

    // Re-opening with an explicit different pane must actually move it there,
    // not silently keep it where it was (the '/panel open <id> top' lie).
    const relocated = manager.open('panel-a', 'bottom');
    expect(relocated.id).toBe('panel-a');
    expect(manager.getPaneOf('panel-a')).toBe('bottom');
    expect(manager.getBottomPane().panels.some((p) => p.id === 'panel-a')).toBe(true);
    expect(manager.getTopPane().panels.some((p) => p.id === 'panel-a')).toBe(false);
  });

  test('getWorkspaceTabs renderer: both panes show selected tab with active indicator after focus switch', () => {
    // Snapshot-style: after switching focus, both active tabs show their indicator
    // (active=true) so the renderer can distinguish them from non-selected tabs.
    const manager = new PanelManager();
    const panelA = makePanel('snap-a', 'SnapA');
    const panelB = makePanel('snap-b', 'SnapB');

    manager.registerType({ id: 'snap-a', name: 'SnapA', icon: 'A', category: 'runtime-ops', description: '', factory: () => panelA });
    manager.registerType({ id: 'snap-b', name: 'SnapB', icon: 'B', category: 'runtime-ops', description: '', factory: () => panelB });

    manager.open('snap-a', 'top');
    manager.open('snap-b', 'bottom');

    // Focus top, then switch to bottom
    manager.focusPane('top');
    manager.focusPane('bottom');

    const tabs = manager.getWorkspaceTabs();
    const activeTabCount = tabs.filter((t) => t.active).length;
    // One active tab per pane that has panels = 2 active tabs total
    expect(activeTabCount).toBe(2);
    // Exactly one focused tab globally
    const focusedTabCount = tabs.filter((t) => t.focused).length;
    expect(focusedTabCount).toBe(1);
    // The focused tab is in the bottom pane
    const focusedTab = tabs.find((t) => t.focused)!;
    expect(focusedTab.pane).toBe('bottom');
  });
});

// ---------------------------------------------------------------------------
// (the purge), modal-redirect mechanism (builds the mechanism;
// B register the actual MIGRATE-TO-MODAL ids against it) and the
// default-panel retarget away from the now-deleted 'panel-list'.
// ---------------------------------------------------------------------------

describe('PanelManager: modal redirect mechanism', () => {
  test('open() on a modal-redirected id invokes the callback and returns a sentinel without constructing the real panel', () => {
    const manager = new PanelManager();
    const factory = mock(() => makePanel('providers-modal-victim', 'Should never be built'));
    manager.registerType({ id: 'providers', name: 'Providers', icon: 'V', category: 'providers', description: '', factory });
    manager.registerModalRedirect('providers', 'providers-modal');

    const seen: string[] = [];
    manager.setOpenModalCallback((name) => seen.push(name));

    const result = manager.open('providers');

    expect(seen).toEqual(['providers-modal']);
    expect(factory).not.toHaveBeenCalled();
    // The sentinel is never added to a pane, the workspace stays empty.
    expect(manager.getAllOpen()).toHaveLength(0);
    expect(manager.getPanel('providers')).toBeNull();
    // The sentinel still satisfies the non-null Panel contract callers expect.
    expect(result.id).toBe('providers');
  });

  test('getModalRedirect() lets a caller (e.g. the /panel command) look up the target before calling open()', () => {
    const manager = new PanelManager();
    manager.registerModalRedirect('settings-sync', 'settings-sync-modal');
    expect(manager.getModalRedirect('settings-sync')).toBe('settings-sync-modal');
    expect(manager.getModalRedirect('git')).toBeUndefined();
  });

  test('a modal redirect is checked before alias resolution and does not require setOpenModalCallback to be wired', () => {
    const manager = new PanelManager();
    manager.registerModalRedirect('sandbox', 'sandbox-modal');
    // No setOpenModalCallback call at all, must not throw.
    expect(() => manager.open('sandbox')).not.toThrow();
  });

  test('a plain panel->panel alias (RETIRE-INTO-FLEET) is unaffected by the modal-redirect map', () => {
    const manager = new PanelManager();
    const fleetPanel = makePanel('fleet', 'Fleet');
    manager.registerType({ id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: '', factory: () => fleetPanel });
    manager.registerAlias('tasks', 'fleet');

    const opened = manager.open('tasks');
    expect(opened).toBe(fleetPanel);
    expect(manager.getPanel('tasks')).toBe(fleetPanel);
  });
});

describe('PanelManager: default panel retargets to fleet, not registry[0]', () => {
  test('toggle() with nothing open falls back to fleet when present, not the first-registered type', () => {
    const manager = new PanelManager();
    // Register 'git' first (mirrors real registration order, development.ts
    // registers before operations.ts) to prove the retarget is explicit, not
    // an accident of registry[0].
    manager.registerType({ id: 'git', name: 'Git', icon: 'G', category: 'development', description: '', factory: () => makePanel('git', 'Git') });
    manager.registerType({ id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: '', factory: () => makePanel('fleet', 'Fleet') });

    manager.toggle();

    expect(manager.getPanel('fleet')).not.toBeNull();
    expect(manager.getPanel('git')).toBeNull();
  });

  test('toggleBottomPane() with an empty bottom pane and only one top panel falls back to fleet', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'git', name: 'Git', icon: 'G', category: 'development', description: '', factory: () => makePanel('git', 'Git') });
    manager.registerType({ id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: '', factory: () => makePanel('fleet', 'Fleet') });
    manager.open('git', 'top');

    manager.toggleBottomPane();

    expect(manager.getPaneOf('fleet')).toBe('bottom');
  });

  test('falls back to registry[0] only when fleet itself is not registered (defensive, should not happen in production)', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'git', name: 'Git', icon: 'G', category: 'development', description: '', factory: () => makePanel('git', 'Git') });
    manager.toggle();
    expect(manager.getPanel('git')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
//, saved-layout tolerance contract. session-workflow.ts's
// reopenPanelsFromReturnContext wraps `panelManager.open(id)` in a
// try/catch per id so a saved layout containing a DELETE-disposition id
// (no alias, e.g. the old 'panel-list'/'thinking'/'tools') resolves-or-skips
// instead of throwing; a RETIRE-INTO-FLEET id (has an alias) opens normally.
// This proves the underlying PanelManager contract that tolerance depends
// on, without re-implementing the full /session resume command flow.
// ---------------------------------------------------------------------------

describe('PanelManager: open() contract backing saved-layout tolerance', () => {
  test('open() throws for an id with no registration and no alias (the DELETE-disposition case)', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'git', name: 'Git', icon: 'G', category: 'development', description: '', factory: () => makePanel('git', 'Git') });
    expect(() => manager.open('panel-list')).toThrow();
  });

  test('open() resolves normally for an id with an alias (the RETIRE-INTO-FLEET case)', () => {
    const manager = new PanelManager();
    const fleetPanel = makePanel('fleet', 'Fleet');
    manager.registerType({ id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: '', factory: () => fleetPanel });
    manager.registerAlias('tasks', 'fleet');
    expect(() => manager.open('tasks')).not.toThrow();
  });

  test('a try/catch reopen loop over a mixed saved layout skips the deleted id and reopens the retired (aliased) one', () => {
    const manager = new PanelManager();
    manager.registerType({ id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: '', factory: () => makePanel('fleet', 'Fleet') });
    manager.registerAlias('tasks', 'fleet');

    const savedLayout = ['panel-list', 'tasks']; // one DELETE id, one RETIRE (aliased) id
    const reopened: string[] = [];
    for (const id of savedLayout) {
      try {
        manager.open(id);
        reopened.push(id);
      } catch {
        // Ignore unknown or currently unavailable panel ids during resume,
        // mirrors session-workflow.ts's reopenPanelsFromReturnContext.
      }
    }

    expect(reopened).toEqual(['tasks']);
    expect(manager.getAllOpen()).toHaveLength(1);
  });
});
