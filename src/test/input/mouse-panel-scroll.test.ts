import { describe, expect, mock, test } from 'bun:test';
import { handleMouseToken, type MouseRouteState } from '../../input/handler-feed-routes.ts';

function buildState(overrides: Partial<MouseRouteState> = {}): MouseRouteState {
  const topPanel = { handleScroll: mock(() => true) };
  return {
    conversationManager: null,
    selection: {
      startSelection: mock(() => {}),
      extendSelection: mock(() => {}),
      endSelection: mock(() => {}),
      clearSelection: mock(() => {}),
    } as unknown as MouseRouteState['selection'],
    panelManager: {
      isVisible: () => true,
      getAllOpen: () => [topPanel],
      getTopPane: () => ({ panels: [topPanel], activeIndex: 0 }),
      getBottomPane: () => ({ panels: [], activeIndex: 0 }),
    } as unknown as MouseRouteState['panelManager'],
    panelMouseLayout: { x: 80, y: 2, width: 40, height: 20, hasBottomPane: false, verticalSplitRatio: 0.5 },
    mouseDownRow: -1,
    mouseDownCol: -1,
    scrollTop: 0,
    viewportHeight: 20,
    lineCount: 100,
    scroll: mock(() => {}),
    requestRender: mock(() => {}),
    handlePaste: mock(() => {}),
    handleCopy: mock(() => {}),
    ...overrides,
  };
}

describe('handleMouseToken panel wheel routing', () => {
  test('wheel over panel routes to panel scroll instead of transcript scroll', () => {
    const panelScroll = mock(() => true);
    const state = buildState({
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ handleScroll: panelScroll }],
        getTopPane: () => ({ panels: [{ handleScroll: panelScroll }], activeIndex: 0 }),
        getBottomPane: () => ({ panels: [], activeIndex: 0 }),
      } as unknown as MouseRouteState['panelManager'],
    });

    const result = handleMouseToken(state, {
      type: 'mouse',
      button: 65,
      col: 90,
      row: 6,
      action: 'press',
    });

    expect(result.handled).toBe(true);
    expect(panelScroll).toHaveBeenCalledWith(3);
    expect(state.scroll).not.toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('wheel outside panel keeps scrolling the transcript', () => {
    const state = buildState();

    const result = handleMouseToken(state, {
      type: 'mouse',
      button: 64,
      col: 20,
      row: 6,
      action: 'press',
    });

    expect(result.handled).toBe(true);
    expect(state.scroll).toHaveBeenCalledWith(-3);
    expect(state.requestRender).not.toHaveBeenCalled();
  });
});

describe('handleMouseToken workspace tab clicks', () => {
  const tabs = [
    { id: 'a', name: 'Alpha', icon: 'A', pane: 'top', active: true, focused: true },
    { id: 'b', name: 'Beta', icon: 'B', pane: 'bottom', active: false, focused: false },
  ];

  function clickableState(onActivate: (i: number) => void): MouseRouteState {
    return buildState({
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{}, {}],
        getWorkspaceTabs: () => tabs,
        activateWorkspaceIndex: onActivate,
      } as unknown as MouseRouteState['panelManager'],
    });
  }

  test('left-click on the workspace bar activates the tab and does not start a selection', () => {
    let activated = -1;
    const state = clickableState((i) => { activated = i; });
    // Bar is at y=2, x=80; the first tab sits just past the ' PANELS ' prefix.
    const result = handleMouseToken(state, {
      type: 'mouse', button: 0, col: 90, row: 2, action: 'press',
    });
    expect(result.handled).toBe(true);
    expect(activated).toBe(0);
    expect(state.selection.startSelection).not.toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('left-click below the bar falls through to text selection', () => {
    let activated = -1;
    const state = clickableState((i) => { activated = i; });
    const result = handleMouseToken(state, {
      type: 'mouse', button: 0, col: 90, row: 6, action: 'press',
    });
    expect(result.handled).toBe(true);
    expect(activated).toBe(-1);
    expect(state.selection.startSelection).toHaveBeenCalled();
  });
});
