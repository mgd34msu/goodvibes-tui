import { describe, expect, mock, test } from 'bun:test';
import { handlePanelFocusToken, type PanelFocusRouteState } from '../../input/handler-feed-routes.ts';

function buildState(overrides: Partial<PanelFocusRouteState> = {}): PanelFocusRouteState {
  return {
    panelManager: {
      isVisible: () => true,
      getAllOpen: () => [{ id: 'system-messages' }],
      getActive: () => null,
      getActivePanel: () => null,
      close: () => {},
    } as unknown as PanelFocusRouteState['panelManager'],
    keybindingsManager: {
      matches: () => false,
    } as unknown as PanelFocusRouteState['keybindingsManager'],
    panelFocused: false,
    commandMode: false,
    searchActive: false,
    autocompleteActive: false,
    requestRender: mock(() => {}),
    handlePathCompletion: mock(() => false),
    cyclePanelTab: mock(() => {}),
    onPanelInputConsumed: undefined,
    ...overrides,
  };
}

describe('handlePanelFocusToken', () => {
  test('Tab focuses the panel workspace from prompt context', () => {
    const state = buildState();
    const result = handlePanelFocusToken(state, {
      type: 'key',
      name: '\t',
      logicalName: 'tab',
      ctrl: false,
      shift: false,
      meta: false,
    });

    expect(result.handled).toBe(true);
    expect(result.panelFocused).toBe(true);
    expect(state.requestRender).toHaveBeenCalled();
    expect(state.handlePathCompletion).toHaveBeenCalledTimes(1);
  });

  test('Tab returns focus from panel workspace back to prompt', () => {
    const state = buildState({ panelFocused: true });
    const result = handlePanelFocusToken(state, {
      type: 'key',
      name: '\t',
      logicalName: 'tab',
      ctrl: false,
      shift: false,
      meta: false,
    });

    expect(result.handled).toBe(true);
    expect(result.panelFocused).toBe(false);
    expect(state.handlePathCompletion).not.toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('Tab keeps prompt focus when path completion consumes it', () => {
    const state = buildState({
      handlePathCompletion: mock(() => true),
    });
    const result = handlePanelFocusToken(state, {
      type: 'key',
      name: '\t',
      logicalName: 'tab',
      ctrl: false,
      shift: false,
      meta: false,
    });

    expect(result.handled).toBe(true);
    expect(result.panelFocused).toBe(false);
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('Alt+digit jumps directly to the Nth workspace tab', () => {
    let jumpedTo = -1;
    const state = buildState({
      panelFocused: true,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        getActive: () => ({ id: 'a', handleInput: () => false }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
        activateWorkspaceIndex: (i: number) => { jumpedTo = i; },
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    // The tokenizer delivers the Alt modifier as `meta`.
    const result = handlePanelFocusToken(state, {
      type: 'key', name: '3', logicalName: '3', ctrl: false, shift: false, meta: true,
    } as never);
    expect(result.handled).toBe(true);
    expect(jumpedTo).toBe(2); // Alt+3 → index 2
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('plain digit is forwarded to the panel, not treated as a tab jump', () => {
    let jumped = false;
    const received: string[] = [];
    const state = buildState({
      panelFocused: true,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }],
        getActive: () => ({ id: 'a', handleInput: (k: string) => { received.push(k); return true; } }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
        activateWorkspaceIndex: () => { jumped = true; },
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    handlePanelFocusToken(state, {
      type: 'key', name: '3', logicalName: '3', ctrl: false, shift: false, meta: false, alt: false,
    } as never);
    expect(jumped).toBe(false);
    expect(received).toEqual(['3']);
  });

  test('panel-focus-toggle binding switches the focused pane', () => {
    let toggled = false;
    const state = buildState({
      panelFocused: true,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }],
        getActive: () => ({ id: 'a', handleInput: () => false }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
        togglePaneFocus: () => { toggled = true; },
      } as unknown as PanelFocusRouteState['panelManager'],
      keybindingsManager: {
        matches: (action: string) => action === 'panel-focus-toggle',
      } as unknown as PanelFocusRouteState['keybindingsManager'],
    });
    const result = handlePanelFocusToken(state, {
      type: 'key', name: '\x07', logicalName: 'g', ctrl: true, shift: false, meta: false,
    } as never);
    expect(result.handled).toBe(true);
    expect(toggled).toBe(true);
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('panel-close is NOT owned by this route (delegated to the global shortcut handler)', () => {
    // panel-close / panel-close-all / panel-tab-next / panel-tab-prev used to be
    // duplicated here but are consumed earlier by handleGlobalShortcutToken, so
    // the copies were unreachable and have been removed. A ctrl-combo that this
    // route does not own must fall through (handled:false) so the global handler
    // can act — and it must NOT close panels or flip focus from here.
    const closed: string[] = [];
    const state = buildState({
      panelFocused: true,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'system-messages' }, { id: 'tasks' }],
        getActive: () => null,
        getActivePanel: () => ({ id: 'system-messages' }),
        close: (id: string) => { closed.push(id); },
      } as unknown as PanelFocusRouteState['panelManager'],
      keybindingsManager: {
        matches: (action: string) => action === 'panel-close',
      } as unknown as PanelFocusRouteState['keybindingsManager'],
    });
    const result = handlePanelFocusToken(state, {
      type: 'key',
      name: '\x18',
      logicalName: 'x',
      ctrl: true,
      shift: false,
      meta: false,
    });

    expect(result.handled).toBe(false);
    expect(result.panelFocused).toBe(true);
    expect(closed).toEqual([]);
  });
});
