import { describe, expect, mock, test } from 'bun:test';
import { handleGlobalShortcutToken, type GlobalShortcutRouteState } from '../../input/handler-shortcuts.ts';

function buildState(overrides: Partial<GlobalShortcutRouteState> = {}): GlobalShortcutRouteState {
  return {
    panelFocused: false,
    panelManager: {
      isVisible: () => true,
      getAllOpen: () => [],
      close: () => {},
      hide: () => {},
      getActivePanel: () => null,
    } as unknown as GlobalShortcutRouteState['panelManager'],
    keybindingsManager: {
      matches: (action: string, token: { logicalName?: string; ctrl?: boolean }) =>
        action === 'panel-picker' && token.logicalName === 'p' && !!token.ctrl,
      // lookup: O(1) inverted-map equivalent used by the refactored handler.
      lookup: (token: { logicalName?: string; ctrl?: boolean }) =>
        token.logicalName === 'p' && !!token.ctrl ? 'panel-picker' : null,
    } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    prompt: '',
    cursorPos: 0,
    commandMode: false,
    autocomplete: null,
    historySearch: { open: mock(() => {}) } as unknown as GlobalShortcutRouteState['historySearch'],
    searchManager: { active: false, open: mock(() => {}), close: mock(() => {}) } as unknown as GlobalShortcutRouteState['searchManager'],
    conversationManager: null,
    commandContext: { openPanelPicker: mock(() => {}), clearScreen: mock(() => {}) } as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    contentWidth: 80,
    getScrollTop: () => 0,
    getWrappedPromptInfo: () => ({ wrappedLines: [''], segments: [{ rawStart: 0, length: 0 }], cursorWrappedLine: 0 }),
    saveUndoState: mock(() => {}),
    requestRender: mock(() => {}),
    scroll: mock(() => {}),
    ensureInputCursorVisible: mock(() => {}),
    handleCopy: mock(() => {}),
    handleCtrlC: mock(() => {}),
    handleBlockCopy: mock(() => {}),
    handleBookmark: mock(() => {}),
    handleBlockSave: mock(() => {}),
    handleDiffApply: mock(() => false),
    handleUndo: mock(() => {}),
    handleRedo: mock(() => {}),
    handlePaste: mock(() => {}),
    handleEscape: mock(() => {}),
    cyclePanelTab: mock(() => {}),
    ...overrides,
  };
}

describe('handleGlobalShortcutToken', () => {
  test('W0.8 sub-fix A: panel-picker (Ctrl+P) is reachable during an active turn — GlobalShortcutRouteState carries no orchestrator/isThinking field to gate on', () => {
    // There is no turn/chain busy guard anywhere in this route (confirmed by
    // exhaustive search of the input pipeline for isBusy/isThinking/etc. —
    // see the W0.8 audit brief). This test locks that in: the shortcut must
    // fire identically regardless of whether a turn is in flight, because
    // the state type this handler receives structurally cannot express
    // "a turn is running" — main.ts's stdin.on('data') handler calls
    // input.feed() unconditionally on every keystroke (main.ts ~743-765),
    // gating only on pendingPermission/recoveryPending/errorAffordanceActive,
    // none of which is turn state.
    const state = buildState({ panelFocused: false });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x10', logicalName: 'p', ctrl: true, shift: false, meta: false },
      24,
    );
    expect(handled).toBe(true);
    expect(state.commandContext?.openPanelPicker).toHaveBeenCalled();
  });

  test('panel-picker remains global while panel workspace has focus', () => {
    const state = buildState({ panelFocused: true });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x10', logicalName: 'p', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.commandContext?.openPanelPicker).toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('panel-close shortcut clears stale panel focus', () => {
    const closed: string[] = [];
    const state = buildState({
      panelFocused: true,
      panelManager: {
        getAllOpen: () => [{ id: 'system-messages' }, { id: 'tasks' }],
        close: (id: string) => { closed.push(id); },
        hide: () => {},
        getActivePanel: () => ({ id: 'system-messages' }),
        isVisible: () => true,
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-close',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x18', logicalName: 'x', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.panelFocused).toBe(false);
    expect(closed).toEqual(['system-messages']);
  });

  test('W1.6: panel-close (Ctrl+X) still closes the panel unconditionally during an active turn — unaffected by the Escape cancel-first gate added in handler-feed-routes.ts', () => {
    // handleGlobalShortcutToken runs before handlePanelFocusToken in the feed
    // loop (handler-feed.ts) and, like panel-picker above, this route has no
    // isThinking/turn-active field to gate on at all — GlobalShortcutRouteState
    // is structurally incapable of expressing "a turn is running", so
    // panel-close cannot become entangled with the new cancel-first Escape
    // precedence (which lives entirely inside handlePanelFocusToken instead).
    const closed: string[] = [];
    const state = buildState({
      panelFocused: true,
      panelManager: {
        getAllOpen: () => [{ id: 'system-messages' }],
        close: (id: string) => { closed.push(id); },
        hide: () => {},
        getActivePanel: () => ({ id: 'system-messages' }),
        isVisible: () => true,
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-close',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x18', logicalName: 'x', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.panelFocused).toBe(false);
    expect(closed).toEqual(['system-messages']);
  });

  test("Wave-3: panel-close (Ctrl+X) gives the active panel's interceptPanelClose() a chance to consume it BEFORE closing (FleetPanel session-tab detach)", () => {
    const closed: string[] = [];
    let intercepted = false;
    const state = buildState({
      panelFocused: true,
      panelManager: {
        getAllOpen: () => [{ id: 'fleet' }],
        close: (id: string) => { closed.push(id); },
        hide: () => {},
        getActivePanel: () => ({ id: 'fleet', interceptPanelClose: () => { intercepted = true; return true; } }),
        isVisible: () => true,
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-close',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x18', logicalName: 'x', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(intercepted).toBe(true);
    expect(closed).toHaveLength(0); // the panel stayed open — Ctrl+X was consumed for the in-panel detach instead
    // UX-C item 1b: a consumed detach still hands focus back to the composer —
    // it used to leave panelFocused untouched (the evaluator's "Ctrl+X detach
    // landed focus in the panel and a typed question became nav keys").
    expect(state.panelFocused).toBe(false);
  });

  test('Wave-3: when interceptPanelClose() returns false (e.g. the root tree tab), Ctrl+X falls through to the ordinary close', () => {
    const closed: string[] = [];
    const state = buildState({
      panelFocused: true,
      panelManager: {
        getAllOpen: () => [{ id: 'fleet' }],
        close: (id: string) => { closed.push(id); },
        hide: () => {},
        getActivePanel: () => ({ id: 'fleet', interceptPanelClose: () => false }),
        isVisible: () => true,
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-close',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x18', logicalName: 'x', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(closed).toEqual(['fleet']);
  });

  test('panel-focus-toggle (Ctrl+G) grabs workspace focus from the prompt', () => {
    const state = buildState({
      panelFocused: false,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'system-messages' }],
        close: () => {},
        hide: () => {},
        getActivePanel: () => ({ id: 'system-messages' }),
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-focus-toggle',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x07', logicalName: 'g', ctrl: true, shift: false, meta: false },
      24,
    );
    expect(handled).toBe(true);
    expect(state.panelFocused).toBe(true);
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('panel-focus-toggle falls through when the workspace already has focus (pane swap handled elsewhere)', () => {
    const state = buildState({
      panelFocused: true,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'system-messages' }],
        close: () => {},
        hide: () => {},
        getActivePanel: () => ({ id: 'system-messages' }),
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-focus-toggle',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x07', logicalName: 'g', ctrl: true, shift: false, meta: false },
      24,
    );
    expect(handled).toBe(false);
    expect(state.panelFocused).toBe(true);
  });

  test('panel-focus-toggle from the prompt is a no-op when no workspace is open', () => {
    const state = buildState({
      panelFocused: false,
      panelManager: {
        isVisible: () => false,
        getAllOpen: () => [],
        close: () => {},
        hide: () => {},
        getActivePanel: () => null,
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-focus-toggle',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x07', logicalName: 'g', ctrl: true, shift: false, meta: false },
      24,
    );
    expect(handled).toBe(false);
    expect(state.panelFocused).toBe(false);
  });

  test('panel-tab-N (Alt+digit) jumps to the Nth workspace tab, routed globally, AND grabs focus (UX-C 1a: a chord is "I\'m going panel-driving")', () => {
    let jumpedTo = -1;
    let focused = false;
    const state = buildState({
      panelFocused: false,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        close: () => {},
        hide: () => {},
        getActivePanel: () => ({ id: 'a' }),
        activateWorkspaceIndex: (i: number) => { jumpedTo = i; },
        focusPanels: () => { focused = true; },
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        // Real Alt tokens carry `meta`; the manager maps that onto the alt combo.
        lookup: (token: { logicalName?: string; meta?: boolean }) =>
          token.meta && token.logicalName === '3' ? 'panel-tab-3' : null,
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '3', logicalName: '3', ctrl: false, shift: false, meta: true },
      24,
    );
    expect(handled).toBe(true);
    expect(jumpedTo).toBe(2); // Alt+3 → index 2
    expect(focused).toBe(true);
    expect(state.panelFocused).toBe(true);
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('panel-tab-N is consumed but a no-op when the workspace is hidden', () => {
    let jumped = false;
    const state = buildState({
      panelFocused: false,
      panelManager: {
        isVisible: () => false,
        getAllOpen: () => [],
        close: () => {},
        hide: () => {},
        getActivePanel: () => null,
        activateWorkspaceIndex: () => { jumped = true; },
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'panel-tab-1',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '1', logicalName: '1', ctrl: false, shift: false, meta: true },
      24,
    );
    expect(handled).toBe(true);
    expect(jumped).toBe(false);
  });

  test('panel-ops (Ctrl+O) opens AND focuses the Fleet panel (ops-control retired to a fleet alias, W6.2 b)', () => {
    const opened: string[] = [];
    let focused = false;
    const state = buildState({
      panelFocused: false,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [],
        close: () => {},
        hide: () => {},
        getActivePanel: () => null,
        open: (id: string) => { opened.push(id); },
        focusPanels: () => { focused = true; },
      } as unknown as GlobalShortcutRouteState['panelManager'],
      keybindingsManager: {
        matches: () => false,
        lookup: (token: { logicalName?: string; ctrl?: boolean }) =>
          token.logicalName === 'o' && !!token.ctrl ? 'panel-ops' : null,
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
      commandContext: {} as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x0f', logicalName: 'o', ctrl: true, shift: false, meta: false },
      24,
    );
    expect(handled).toBe(true);
    expect(opened).toEqual(['fleet']);
    expect(focused).toBe(true);
    expect(state.panelFocused).toBe(true);
    expect(state.requestRender).toHaveBeenCalled();
  });

  // UX-C item 2: F2 and Ctrl+O TOGGLE the Fleet panel — the same chord that
  // opens+focuses it also closes it when it is already open and focused. The
  // old behavior only ever opened+focused, which is why "F2 pressed 4x never
  // closed the panel" (evaluator finding): a second press while already
  // focused was silently swallowed by handlePanelFocusToken before it could
  // ever reach a close branch. F2 is not in the keybinding table (hardcoded,
  // like pageup/pagedown/escape), so these tests drive it via logicalName
  // directly rather than through keybindingsManager.lookup.
  describe('F2 / Ctrl+O — toggleFleetPanel (UX-C item 2)', () => {
    test('F2 opens AND focuses the Fleet panel when it is not open', () => {
      const opened: string[] = [];
      let focused = false;
      const state = buildState({
        panelFocused: false,
        panelManager: {
          isVisible: () => true,
          getAllOpen: () => [],
          close: () => {},
          hide: () => {},
          getActivePanel: () => null,
          open: (id: string) => { opened.push(id); },
          focusPanels: () => { focused = true; },
        } as unknown as GlobalShortcutRouteState['panelManager'],
      });
      const handled = handleGlobalShortcutToken(
        state,
        { type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: false, shift: false, meta: false },
        24,
      );
      expect(handled).toBe(true);
      expect(opened).toEqual(['fleet']);
      expect(focused).toBe(true);
      expect(state.panelFocused).toBe(true);
    });

    test('F2 CLOSES the Fleet panel when it is already open and focused (the "4x never closed" regression)', () => {
      const closed: string[] = [];
      const state = buildState({
        panelFocused: true,
        panelManager: {
          isVisible: () => true,
          getAllOpen: () => [{ id: 'fleet' }],
          close: (id: string) => { closed.push(id); },
          hide: () => {},
          getActivePanel: () => ({ id: 'fleet' }),
        } as unknown as GlobalShortcutRouteState['panelManager'],
      });
      const handled = handleGlobalShortcutToken(
        state,
        { type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: false, shift: false, meta: false },
        24,
      );
      expect(handled).toBe(true);
      expect(closed).toEqual(['fleet']);
      expect(state.panelFocused).toBe(false);
    });

    test('F2 FOCUSES (does not close) the Fleet panel when it is open but NOT the focused tab', () => {
      const opened: string[] = [];
      let focused = false;
      const state = buildState({
        panelFocused: true,
        panelManager: {
          isVisible: () => true,
          getAllOpen: () => [{ id: 'fleet' }, { id: 'git' }],
          close: () => {},
          hide: () => {},
          // 'git' is the currently-focused active panel, not 'fleet'.
          getActivePanel: () => ({ id: 'git' }),
          open: (id: string) => { opened.push(id); },
          focusPanels: () => { focused = true; },
        } as unknown as GlobalShortcutRouteState['panelManager'],
      });
      const handled = handleGlobalShortcutToken(
        state,
        { type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: false, shift: false, meta: false },
        24,
      );
      expect(handled).toBe(true);
      expect(opened).toEqual(['fleet']); // brought to front, not toggled closed
      expect(focused).toBe(true);
      expect(state.panelFocused).toBe(true);
    });

    test('Ctrl+F2 / Alt+F2 are NOT the bare toggle (modifier guard, mirrors pageup/pagedown)', () => {
      const state = buildState({ panelFocused: false });
      const handled = handleGlobalShortcutToken(
        state,
        { type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: true, shift: false, meta: false },
        24,
      );
      expect(handled).toBe(false);
    });

    test('Ctrl+O CLOSES the Fleet panel when it is already open and focused (same toggle as F2)', () => {
      const closed: string[] = [];
      const state = buildState({
        panelFocused: true,
        panelManager: {
          isVisible: () => true,
          getAllOpen: () => [{ id: 'fleet' }],
          close: (id: string) => { closed.push(id); },
          hide: () => {},
          getActivePanel: () => ({ id: 'fleet' }),
        } as unknown as GlobalShortcutRouteState['panelManager'],
        keybindingsManager: {
          matches: () => false,
          lookup: (token: { logicalName?: string; ctrl?: boolean }) =>
            token.logicalName === 'o' && !!token.ctrl ? 'panel-ops' : null,
        } as unknown as GlobalShortcutRouteState['keybindingsManager'],
      });
      const handled = handleGlobalShortcutToken(
        state,
        { type: 'key', name: '\x0f', logicalName: 'o', ctrl: true, shift: false, meta: false },
        24,
      );
      expect(handled).toBe(true);
      expect(closed).toEqual(['fleet']);
      expect(state.panelFocused).toBe(false);
    });
  });

  test('BARE PageUp/PageDown still scroll the transcript (fast-path preserved)', () => {
    const scroll = mock((_n: number) => {});
    const cyclePanelTab = mock((_d: 'next' | 'prev') => {});
    const state = buildState({ panelFocused: false, scroll, cyclePanelTab });
    expect(handleGlobalShortcutToken(state, { type: 'key', name: '', logicalName: 'pageup', ctrl: false, shift: false, meta: false }, 24)).toBe(true);
    expect(handleGlobalShortcutToken(state, { type: 'key', name: '', logicalName: 'pagedown', ctrl: false, shift: false, meta: false }, 24)).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(cyclePanelTab).not.toHaveBeenCalled();
  });

  test('Ctrl+PageUp / Ctrl+PageDown reach the keybinding lookup (NOT the scroll fast-path) and cycle tabs (W6.2 b)', () => {
    const scroll = mock((_n: number) => {});
    const cyclePanelTab = mock((_d: 'next' | 'prev') => {});
    const state = buildState({
      panelFocused: false,
      scroll,
      cyclePanelTab,
      keybindingsManager: {
        matches: () => false,
        lookup: (token: { logicalName?: string; ctrl?: boolean }) => {
          if (token.logicalName === 'pageup' && token.ctrl) return 'panel-tab-prev';
          if (token.logicalName === 'pagedown' && token.ctrl) return 'panel-tab-next';
          return null;
        },
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });
    // \x1b[5;5~ / \x1b[6;5~ tokenize to pageup/pagedown with ctrl:true.
    expect(handleGlobalShortcutToken(state, { type: 'key', name: '', logicalName: 'pageup', ctrl: true, shift: false, meta: false }, 24)).toBe(true);
    expect(handleGlobalShortcutToken(state, { type: 'key', name: '', logicalName: 'pagedown', ctrl: true, shift: false, meta: false }, 24)).toBe(true);
    expect(cyclePanelTab.mock.calls).toEqual([['prev'], ['next']]);
    expect(scroll).not.toHaveBeenCalled(); // guard kept the chords out of the scroll fast-path
  });

  test('escape does not bypass panel focus handling', () => {
    const state = buildState({ panelFocused: true });
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(false);
    expect(state.handleEscape).not.toHaveBeenCalled();
  });

  test('page scroll keys do not bypass focused panel handling', () => {
    const state = buildState({ panelFocused: true });

    const pageUpHandled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b[5~', logicalName: 'pageup', ctrl: false, shift: false, meta: false },
      24,
    );
    const pageDownHandled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b[6~', logicalName: 'pagedown', ctrl: false, shift: false, meta: false },
      24,
    );

    expect(pageUpHandled).toBe(false);
    expect(pageDownHandled).toBe(false);
    expect(state.scroll).not.toHaveBeenCalled();
  });
});
