/**
 * item 1e: Esc-from-focused-panel must always return to the composer —
 * including after F2, and including when a modal sat on top of the focused
 * panel in the meantime. One evaluator reported Escape working correctly;
 * an earlier one reported a case where it didn't. Static analysis of the
 * modal-stack/panel-focus interaction (handler-modal-stack.ts's
 * modalOpened/handleEscape, and handlePanelFocusToken's own two-stage
 * escape branch in handler-feed-routes.ts) found the invariant already
 * correctly wired: `modalOpened()` snapshots `modalReturnFocus` from the
 * CURRENT panelFocused/indicatorFocused state the moment a modal is pushed
 * onto an empty stack, and `handleEscape()`'s `restoreFocus()` reads it back
 * once the stack drains — verified here through the REAL
 * InputHandler.feed() pipeline (not just the isolated pure functions already
 * covered by modal-focus-restoration.test.ts and panel-escape-contract.test.ts)
 * so a regression in the wiring between them, not just in either function
 * alone, would be caught.
 *
 * Confirmed root causes for the evaluator-reported friction were elsewhere
 * (both fixed as part of, not here):
 *   - F2 pressed while already focused used to be silently swallowed by
 *     handlePanelFocusToken before ever reaching F2's toggle logic — see
 *     global-shortcuts.test.ts's "F2 / Ctrl+O — toggleFleetPanel" suite.
 *   - Ctrl+X detach (FleetPanel session-tab, interceptPanelClose) used to
 *     leave panelFocused untouched — see the interceptPanelClose test
 *     in global-shortcuts.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { FocusTracker } from '../../core/focus-tracker.ts';
import type { Panel } from '../../panels/types.ts';

/** A Fleet stand-in whose handleInput never consumes anything (mirrors the root tree tab: no confirm armed, no session tab active). */
function makeStubFleetPanel(): Panel {
  return {
    id: 'fleet',
    name: 'Fleet',
    icon: '⊟',
    category: 'runtime-ops',
    isTransient: false,
    isPinned: false,
    needsRender: true,
    onActivate: () => {},
    onDeactivate: () => {},
    onDestroy: () => {},
    invalidate: () => {},
    markRendered: () => {},
    render: () => [],
    handleInput: () => false,
  };
}

function buildHandler(panelManager: PanelManager): InputHandler {
  const uiServices = {
    agents: {
      agentManager: { getAllAgents: () => [], on: () => {}, off: () => {} } as unknown,
      agentMessageBus: { on: () => {}, off: () => {} } as unknown,
      wrfcController: { on: () => {}, off: () => {} } as unknown,
    },
    environment: {
      shellPaths: {
        homeDirectory: '/tmp',
        workingDirectory: '/tmp',
        resolveProjectPath: (...parts: string[]) => parts.join('/'),
      },
    },
    providers: {
      favoritesStore: { getAll: () => [] } as unknown,
      benchmarkStore: { getAll: () => [] } as unknown,
      providerRegistry: { getAll: () => [] } as unknown,
    },
    sessions: { sessionManager: { getAll: () => [] } as unknown },
    shell: {
      processManager: { getAll: () => [] } as unknown,
      bookmarkManager: { getAll: () => [] } as unknown,
      profileManager: { getAll: () => [] } as unknown,
      panelManager,
      // Real keybindings would never bind bare escape/f2 to a lookup action —
      // stubbing to always-false/null keeps the outcome determined by the
      // fast-path/global-shortcut logic under test, not by keybinding config.
      keybindingsManager: { matches: () => false, lookup: () => null } as unknown,
    },
    platform: { focusTracker: new FocusTracker() },
  };

  const selection = new SelectionManager();
  return new InputHandler(
    () => {},
    selection,
    () => 0,
    () => 24,
    (() => ({ getLineCount: () => 0 })) as unknown as () => import('../../core/history.ts').InfiniteBuffer,
    () => {},
    () => {},
    uiServices as unknown as import('../../runtime/ui-services.ts').UiRuntimeServices,
  );
}

describe('Esc-from-focused-panel through the real feed() pipeline (item 1e)', () => {
  test('F2 focuses the panel, then a single Escape (no modal involved) returns focus to the composer', () => {
    const panelManager = new PanelManager();
    panelManager.registerType({
      id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: 'Live fleet tree',
      factory: makeStubFleetPanel,
    });
    const handler = buildHandler(panelManager);

    handler.feed('\x1bOQ'); // F2
    expect(handler.panelFocused).toBe(true);
    expect(panelManager.getActive()?.id).toBe('fleet');

    handler.feed('\x1b'); // bare Escape
    expect(handler.panelFocused).toBe(false);
  });

  test('F2 focuses the panel; a modal opened while focused restores PANEL focus on its own Escape, and a second Escape then returns to the composer', () => {
    const panelManager = new PanelManager();
    panelManager.registerType({
      id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: 'Live fleet tree',
      factory: makeStubFleetPanel,
    });
    const handler = buildHandler(panelManager);

    handler.feed('\x1bOQ'); // F2: open + focus fleet
    expect(handler.panelFocused).toBe(true);

    // A modal opens while the panel already has focus. modalOpened() snapshots
    // modalReturnFocus from the CURRENT focus state the instant the stack goes
    // from empty to non-empty — mirrors what any real opener (e.g. a future
    // panel-driven modal affordance) does internally.
    handler.modalOpened('help');
    handler.helpOverlayActive = true;

    // First Escape (real pipeline: handleOverlayToken sees helpOverlayActive
    // and calls the modal-stack-aware handleEscape() BEFORE the token can ever
    // reach handlePanelFocusToken) closes only the modal and restores focus to
    // the panel — NOT the composer, because modalReturnFocus was 'panel'.
    handler.feed('\x1b');
    expect(handler.helpOverlayActive).toBe(false);
    expect(handler.panelFocused).toBe(true);
    expect(panelManager.getActive()?.id).toBe('fleet');

    // Second Escape: no modal is active anymore, so this one reaches
    // handlePanelFocusToken's own two-stage contract; the stub panel consumes
    // nothing, so focus returns to the composer.
    handler.feed('\x1b');
    expect(handler.panelFocused).toBe(false);
  });

  test('a modal opened from the UNFOCUSED composer restores composer focus on close, never grabbing the panel', () => {
    const panelManager = new PanelManager();
    panelManager.registerType({
      id: 'fleet', name: 'Fleet', icon: '⊟', category: 'runtime-ops', description: 'Live fleet tree',
      factory: makeStubFleetPanel,
    });
    const handler = buildHandler(panelManager);

    // Open the panel but explicitly return focus to the composer first (the
    // 1a "command path" posture) before a modal opens.
    handler.feed('\x1bOQ'); // F2
    panelManager.focusPrompt();
    expect(handler.panelFocused).toBe(false);

    handler.modalOpened('help');
    handler.helpOverlayActive = true;
    handler.feed('\x1b');

    expect(handler.helpOverlayActive).toBe(false);
    expect(handler.panelFocused).toBe(false); // never flipped to the panel
  });
});
