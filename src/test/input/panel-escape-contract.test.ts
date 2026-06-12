/**
 * UX Anti-Regression: Panel Escape Two-Stage Contract
 *
 * Pins the I6 two-stage escape behavior in handlePanelFocusToken:
 *
 *   Stage 1 — active panel gets escape FIRST:
 *     panel.handleInput('escape') returns true  → panel consumed it;
 *     focus stays in the panel, render is requested, global escape does not run.
 *
 *   Stage 2 — if panel does not consume escape (returns false or is absent):
 *     panelFocused becomes false (global handler acts, user returns to prompt).
 *
 * NOTE: panels receive lowercase 'escape' — the working tree already has
 * those fixes in src/panels/.
 *
 * All tests are synchronous. No real I/O, no event bus.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { handlePanelFocusToken, type PanelFocusRouteState } from '../../input/handler-feed-routes.ts';
import type { Panel } from '../../panels/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Panel mock. handleInput is optional per the Panel interface. */
function makePanel(handleInputResult: boolean): Panel {
  return {
    id: 'test-panel',
    name: 'Test Panel',
    icon: 'T',
    category: 'development',
    onActivate: () => {},
    onDeactivate: () => {},
    onDestroy: () => {},
    render: (_w: number, _h: number) => [],
    isTransient: false,
    isPinned: false,
    needsRender: false,
    invalidate: () => {},
    markRendered: () => {},
    handleInput: mock((_key: string) => handleInputResult),
  } as unknown as Panel;
}

/**
 * Build a PanelFocusRouteState with panelFocused=true and a given active panel.
 * Mirrors the setup in panel-focus-route.test.ts.
 */
function buildFocusedState(
  activePanel: Panel | null,
  overrides: Partial<PanelFocusRouteState> = {},
): PanelFocusRouteState {
  return {
    panelManager: {
      isVisible: () => true,
      getAllOpen: () => (activePanel ? [activePanel] : []),
      getActive: () => activePanel,
      getActivePanel: () => activePanel,
      close: () => {},
    } as unknown as PanelFocusRouteState['panelManager'],
    keybindingsManager: {
      matches: () => false,
    } as unknown as PanelFocusRouteState['keybindingsManager'],
    panelFocused: true,
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

const ESCAPE_TOKEN = {
  type: 'key' as const,
  name: '\x1b',
  logicalName: 'escape',
  ctrl: false,
  shift: false,
  meta: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('panel-escape-contract: two-stage escape routing', () => {
  describe('Stage 1 — panel consumes escape (returns true)', () => {
    test('when panel consumes escape, result.handled is true', () => {
      const panel = makePanel(true);
      const state = buildFocusedState(panel);

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(result.handled).toBe(true);
    });

    test('when panel consumes escape, panelFocused remains true (focus stays)', () => {
      const panel = makePanel(true);
      const state = buildFocusedState(panel);

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(result.panelFocused).toBe(true);
    });

    test('when panel consumes escape, requestRender is called', () => {
      const panel = makePanel(true);
      const state = buildFocusedState(panel);

      handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(state.requestRender).toHaveBeenCalled();
    });

    test('when panel consumes escape, panel.handleInput received lowercase escape', () => {
      const panel = makePanel(true);
      const state = buildFocusedState(panel);

      handlePanelFocusToken(state, ESCAPE_TOKEN);

      // Panel must receive the lowercase string 'escape' — not 'Escape', not '\x1b'
      expect(panel.handleInput).toHaveBeenCalledWith('escape');
    });

    test('when panel consumes escape, onPanelInputConsumed is called if provided', () => {
      const panel = makePanel(true);
      const consumed = mock((_p: Panel | null, _key: string) => {});
      const state = buildFocusedState(panel, { onPanelInputConsumed: consumed });

      handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(consumed).toHaveBeenCalledWith(panel, 'escape');
    });
  });

  describe('Stage 2 — panel does not consume escape (returns false)', () => {
    test('when panel returns false for escape, result.handled is still true (escape is always handled)', () => {
      const panel = makePanel(false);
      const state = buildFocusedState(panel);

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(result.handled).toBe(true);
    });

    test('when panel returns false for escape, panelFocused becomes false (global handler acts)', () => {
      const panel = makePanel(false);
      const state = buildFocusedState(panel);

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(result.panelFocused).toBe(false);
    });

    test('when panel returns false for escape, requestRender is called', () => {
      const panel = makePanel(false);
      const state = buildFocusedState(panel);

      handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(state.requestRender).toHaveBeenCalled();
    });

    test('when panel returns false for escape, panel.handleInput was still called', () => {
      const panel = makePanel(false);
      const state = buildFocusedState(panel);

      handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(panel.handleInput).toHaveBeenCalledWith('escape');
    });
  });

  describe('Stage 2 — no active panel', () => {
    test('when no active panel, escape unfocuses panel (panelFocused false)', () => {
      const state = buildFocusedState(null);

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(result.panelFocused).toBe(false);
    });

    test('when no active panel, result.handled is true', () => {
      const state = buildFocusedState(null);

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(result.handled).toBe(true);
    });

    test('when no active panel, requestRender is called', () => {
      const state = buildFocusedState(null);

      handlePanelFocusToken(state, ESCAPE_TOKEN);

      expect(state.requestRender).toHaveBeenCalled();
    });
  });

  describe('Escape contract is not triggered when panel is not focused', () => {
    test('escape token with panelFocused=false is not handled by panel route', () => {
      const panel = makePanel(true);
      const state = buildFocusedState(panel, { panelFocused: false });

      const result = handlePanelFocusToken(state, ESCAPE_TOKEN);

      // When panelFocused=false, the token is not routed to the panel at all
      expect(result.handled).toBe(false);
      expect(result.panelFocused).toBe(false);
      expect(panel.handleInput).not.toHaveBeenCalled();
    });
  });
});
