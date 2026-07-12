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
    isPasteToken: false,
    now: 0,
    burstGuard: { timestamps: [], suspended: false, hintShown: false },
    isTurnActive: () => false,
    cancelGeneration: mock(() => {}),
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

  test('Alt+digit is NOT owned by this route (delegated to the global panel-tab-N action)', () => {
    // promoted Alt+1..9 to real, rebindable KeyActions (panel-tab-1..9)
    // routed by handleGlobalShortcutToken, which runs earlier in the feed loop.
    // By the time a meta+digit token reaches this focused-panel route it has
    // already been consumed globally, so here it must fall through (handled:false)
    // via the ctrl/meta guard and must NOT jump tabs from this route.
    let jumped = false;
    const state = buildState({
      panelFocused: true,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        getActive: () => ({ id: 'a', handleInput: () => false }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
        activateWorkspaceIndex: () => { jumped = true; },
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    // The tokenizer delivers the Alt modifier as `meta`.
    const result = handlePanelFocusToken(state, {
      type: 'key', name: '3', logicalName: '3', ctrl: false, shift: false, meta: true,
    } as never);
    expect(result.handled).toBe(false);
    expect(result.panelFocused).toBe(true);
    expect(jumped).toBe(false);
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

  test('a single-character text token is still dispatched as a panel hotkey (unchanged)', () => {
    const received: string[] = [];
    const state = buildState({
      panelFocused: true,
      isPasteToken: false,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }],
        getActive: () => ({ id: 'a', handleInput: (k: string) => { received.push(k); return true; } }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    const result = handlePanelFocusToken(state, { type: 'text', value: 'r' });
    expect(result.handled).toBe(true);
    expect(result.panelFocused).toBe(true);
    expect(received).toEqual(['r']);
  });

  test('Invariant B repro: two discrete 1-char tokens (isPasteToken false) BOTH reach the focused panel, focus unchanged', () => {
    // The old per-feed char-sum burst guard flagged "j then k landing in one
    // feed()" as a burst and yanked focus to the composer, dropping both nav
    // keys. Under the per-token model each 1-char token has isPasteToken=false
    // and is delivered to the panel one at a time.
    const received: string[] = [];
    const state = buildState({
      panelFocused: true,
      isPasteToken: false,
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }],
        getActive: () => ({ id: 'a', name: 'fleet', handleInput: (k: string) => { received.push(k); return true; } }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    const first = handlePanelFocusToken(state, { type: 'text', value: 'j' });
    const second = handlePanelFocusToken(state, { type: 'text', value: 'k' });
    expect(received).toEqual(['j', 'k']);
    expect(first.handled).toBe(true);
    expect(first.panelFocused).toBe(true);
    expect(second.handled).toBe(true);
    expect(second.panelFocused).toBe(true);
  });

  test('Invariant A: a paste (one multi-char token) into a non-capturing focused panel is DROPPED with a hint, focus UNCHANGED', () => {
    const received: string[] = [];
    const hints: string[] = [];
    const state = buildState({
      panelFocused: true,
      isPasteToken: true,
      onPasteDropped: (panelName: string) => { hints.push(panelName); },
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }],
        getActive: () => ({ id: 'a', name: 'fleet', handleInput: (k: string) => { received.push(k); return true; } }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    // A real bracketed paste tokenizes to ONE 'text' token whose value is the
    // whole pasted string (see InputTokenizer, tokenizer.js:18-28).
    const result = handlePanelFocusToken(state, { type: 'text', value: 'hello world' });
    expect(received).toEqual([]);              // not exploded into per-char hotkeys
    expect(result.handled).toBe(true);          // consumed here — never reaches the composer
    expect(result.panelFocused).toBe(true);     // focus NOT flipped to the composer
    expect(hints).toEqual(['fleet']);           // one-shot hint names the focused panel
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('a paste is forwarded char-by-char when the focused panel owns a text capture (e.g. a `/`-search or steer-draft field)', () => {
    const received: string[] = [];
    const hints: string[] = [];
    const state = buildState({
      panelFocused: true,
      isPasteToken: true,
      onPasteDropped: (panelName: string) => { hints.push(panelName); },
      panelManager: {
        isVisible: () => true,
        getAllOpen: () => [{ id: 'a' }],
        getActive: () => ({
          id: 'a',
          name: 'fleet',
          handleInput: (k: string) => { received.push(k); return true; },
          isCapturingTextBurst: () => true,
        }),
        getActivePanel: () => ({ id: 'a' }),
        close: () => {},
      } as unknown as PanelFocusRouteState['panelManager'],
    });
    const result = handlePanelFocusToken(state, { type: 'text', value: 'abc' });
    expect(received).toEqual(['a', 'b', 'c']);
    expect(hints).toEqual([]);                  // capture consumed it — no drop hint
    expect(result.handled).toBe(true);
    expect(result.panelFocused).toBe(true);
  });

  // item 1d: '/' is a new, explicit transfer verb — consistent with the
  // Invariant (focus only ever moves on an explicit verb, never
  // implicitly) — that returns focus to the composer AND lets the '/' land
  // there to start a command, from any focused panel that isn't itself
  // capturing free text.
  describe("'/' explicit transfer verb (item 1d)", () => {
    test("'/' from a non-capturing focused panel returns focus to the composer and is NOT consumed here (falls through to the composer's own '/' handling)", () => {
      const received: string[] = [];
      const state = buildState({
        panelFocused: true,
        panelManager: {
          isVisible: () => true,
          getAllOpen: () => [{ id: 'a' }],
          getActive: () => ({ id: 'a', name: 'fleet', handleInput: (k: string) => { received.push(k); return true; } }),
          getActivePanel: () => ({ id: 'a' }),
          close: () => {},
        } as unknown as PanelFocusRouteState['panelManager'],
      });
      const result = handlePanelFocusToken(state, { type: 'text', value: '/' });
      expect(received).toEqual([]);            // never dispatched to the panel as a keystroke
      expect(result.handled).toBe(false);       // falls through — the composer's text route arms it
      expect(result.panelFocused).toBe(false);  // focus already flipped back here
    });

    test("a panel that captures free text (isCapturingTextBurst) keeps '/' for itself — capture wins", () => {
      const received: string[] = [];
      const state = buildState({
        panelFocused: true,
        panelManager: {
          isVisible: () => true,
          getAllOpen: () => [{ id: 'a' }],
          getActive: () => ({
            id: 'a',
            name: 'fleet',
            handleInput: (k: string) => { received.push(k); return true; },
            isCapturingTextBurst: () => true,
          }),
          getActivePanel: () => ({ id: 'a' }),
          close: () => {},
        } as unknown as PanelFocusRouteState['panelManager'],
      });
      const result = handlePanelFocusToken(state, { type: 'text', value: '/' });
      expect(received).toEqual(['/']);          // the panel's own filter/draft got it
      expect(result.handled).toBe(true);
      expect(result.panelFocused).toBe(true);   // focus stays on the panel
    });
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

// ---------------------------------------------------------------------------
// item 5 — paste flood guard (rate-based; see panel-paste-flood-guard.ts)
// ---------------------------------------------------------------------------

describe('handlePanelFocusToken — paste flood guard (item 5)', () => {
  function panelManagerWithHandler(received: string[], overrides: { isCapturingTextBurst?: () => boolean } = {}) {
    return {
      isVisible: () => true,
      getAllOpen: () => [{ id: 'a' }],
      getActive: () => ({
        id: 'a',
        name: 'fleet',
        handleInput: (k: string) => { received.push(k); return true; },
        ...overrides,
      }),
      getActivePanel: () => ({ id: 'a' }),
      close: () => {},
    } as unknown as PanelFocusRouteState['panelManager'];
  }

  test('a 20-token burst (unbracketed-paste replay) dispatches at most 8, shows the drop hint exactly once, and never flips focus', () => {
    const received: string[] = [];
    const hints: string[] = [];
    const burstGuard = { timestamps: [], suspended: false, hintShown: false };
    const state = buildState({
      panelFocused: true,
      isPasteToken: false,
      burstGuard,
      onPasteDropped: (name: string) => hints.push(name),
      panelManager: panelManagerWithHandler(received),
    });
    const t0 = 1_000_000;
    let result;
    for (let i = 0; i < 20; i++) {
      result = handlePanelFocusToken({ ...state, now: t0 + i }, { type: 'text', value: 'K' });
    }
    expect(received.length).toBeLessThanOrEqual(8);
    expect(hints).toEqual(['fleet']); // one-shot — not shown 12 more times
    expect(result!.panelFocused).toBe(true); // never flipped to the composer
  });

  test('6 rapid keys (under the threshold) all dispatch — human typing is unaffected', () => {
    const received: string[] = [];
    const hints: string[] = [];
    const burstGuard = { timestamps: [], suspended: false, hintShown: false };
    const state = buildState({
      panelFocused: true,
      isPasteToken: false,
      burstGuard,
      onPasteDropped: (name: string) => hints.push(name),
      panelManager: panelManagerWithHandler(received),
    });
    const t0 = 2_000_000;
    for (let i = 0; i < 6; i++) {
      handlePanelFocusToken({ ...state, now: t0 + i }, { type: 'text', value: 'j' });
    }
    expect(received).toEqual(['j', 'j', 'j', 'j', 'j', 'j']);
    expect(hints).toEqual([]);
  });

  test('a capturing panel (isCapturingTextBurst) receives the full burst untouched by the flood guard', () => {
    const received: string[] = [];
    const hints: string[] = [];
    const burstGuard = { timestamps: [], suspended: false, hintShown: false };
    const state = buildState({
      panelFocused: true,
      isPasteToken: false,
      burstGuard,
      onPasteDropped: (name: string) => hints.push(name),
      panelManager: panelManagerWithHandler(received, { isCapturingTextBurst: () => true }),
    });
    const t0 = 3_000_000;
    for (let i = 0; i < 20; i++) {
      handlePanelFocusToken({ ...state, now: t0 + i }, { type: 'text', value: 'z' });
    }
    expect(received.length).toBe(20); // every character, same as before this guard existed
    expect(hints).toEqual([]);
  });

  test('composer-focused tokens (panelFocused=false) bypass this route entirely, regardless of burst rate — the composer path is untouched', () => {
    const burstGuard = { timestamps: [], suspended: false, hintShown: false };
    const state = buildState({ panelFocused: false, isPasteToken: false, burstGuard });
    const t0 = 4_000_000;
    let result;
    for (let i = 0; i < 20; i++) {
      result = handlePanelFocusToken({ ...state, now: t0 + i }, { type: 'text', value: 'q' });
    }
    expect(result!.handled).toBe(false);
    expect(burstGuard.timestamps).toEqual([]); // the guard never even engages off this route
  });

  test('suspension is sticky (does not flap) but lifts after a genuine quiet gap, re-arming the one-shot hint for a later burst', () => {
    const received: string[] = [];
    const hints: string[] = [];
    const burstGuard = { timestamps: [], suspended: false, hintShown: false };
    const state = buildState({
      panelFocused: true,
      isPasteToken: false,
      burstGuard,
      onPasteDropped: (name: string) => hints.push(name),
      panelManager: panelManagerWithHandler(received),
    });
    const t0 = 5_000_000;
    for (let i = 0; i < 12; i++) handlePanelFocusToken({ ...state, now: t0 + i }, { type: 'text', value: 'a' }); // first burst
    expect(hints).toEqual(['fleet']);
    const dispatchedFromFirstBurst = received.length;

    // A quiet gap longer than the window ends the first burst.
    const t1 = t0 + 1000;
    handlePanelFocusToken({ ...state, now: t1 }, { type: 'text', value: 'b' }); // human keystroke after the pause
    expect(received.length).toBe(dispatchedFromFirstBurst + 1);

    for (let i = 0; i < 12; i++) handlePanelFocusToken({ ...state, now: t1 + 20 + i }, { type: 'text', value: 'c' }); // second burst
    expect(hints).toEqual(['fleet', 'fleet']); // re-armed — a later burst gets its own one-shot hint
  });
});
