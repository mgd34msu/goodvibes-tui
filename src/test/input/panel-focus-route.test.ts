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

  test('panel close hotkey always returns focus to prompt even when another panel remains open', () => {
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

    expect(result.handled).toBe(true);
    expect(result.panelFocused).toBe(false);
    expect(closed).toEqual(['system-messages']);
    expect(state.requestRender).toHaveBeenCalled();
  });
});
