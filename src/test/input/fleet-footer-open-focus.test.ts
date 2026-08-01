/**
 * Bug fix (a replay regression): opening the Fleet panel via the footer
 * status-strip route (Down to focus the process indicator, then Enter) opened
 * the panel WITHOUT transferring keyboard focus to it — j/k/K/i silently
 * landed in the composer until the user manually pressed Tab. The Ctrl+P
 * panel-picker launcher route (ui-openers.ts openPanelPicker) focuses
 * correctly because it calls panelManager.focusPanels() right after opening;
 * the footer route's openFleetPanel() closure (handler-feed.ts, wired into
 * handleIndicatorFocusToken) called panelManager.open('fleet') but never
 * did the same.
 *
 * This test drives the REAL InputHandler.feed() pipeline (not just the
 * isolated handleIndicatorFocusToken route — see
 * panel-entry-points-reachable.test.ts for that) so a regression in the
 * openFleetPanel() closure itself is caught, not just a regression in the
 * route function it is passed to.
 */
import { describe, test, expect } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { PanelManager } from '../../panels/panel-manager.ts';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { Panel } from '../../panels/types.ts';

/** Minimal stand-in for FleetPanel: records handleInput calls, never renders real content. */
function makeStubFleetPanel(): Panel & { receivedKeys: string[] } {
  const receivedKeys: string[] = [];
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
    handleInput: (key: string) => { receivedKeys.push(key); return true; },
    receivedKeys,
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
      // Real keybindings would never bind plain 'enter'/'j' to a global
      // shortcut action; stubbing to always-false keeps this test's outcome
      // determined by the fleet-open focus fix, not by keybinding config.
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
    (() => ({ getLineCount: () => 0 })) as unknown as () => import('@pellux/goodvibes-terminal-shell').InfiniteBuffer,
    () => {},
    () => {},
    uiServices as unknown as import('../../runtime/ui-services.ts').UiRuntimeServices,
  );
}

describe('opening the Fleet panel via the footer indicator route transfers keyboard focus', () => {
  test('Enter on the focused indicator opens fleet AND focuses the panel workspace immediately (no Tab needed)', () => {
    const panelManager = new PanelManager();
    const stub = makeStubFleetPanel();
    panelManager.registerType({
      id: 'fleet',
      name: 'Fleet',
      icon: '⊟',
      category: 'runtime-ops',
      description: 'Live fleet tree',
      factory: () => stub,
    });

    const handler = buildHandler(panelManager);
    handler.indicatorFocused = true;
    expect(handler.panelFocused).toBe(false);

    handler.feed('\r'); // Enter

    expect(panelManager.getActive()?.id).toBe('fleet');
    expect(panelManager.getFocusTarget()).toBe('panel');
    expect(handler.panelFocused).toBe(true);
  });

  test('immediately after opening, j reaches the fleet panel — nothing lands in the composer', () => {
    const panelManager = new PanelManager();
    const stub = makeStubFleetPanel();
    panelManager.registerType({
      id: 'fleet',
      name: 'Fleet',
      icon: '⊟',
      category: 'runtime-ops',
      description: 'Live fleet tree',
      factory: () => stub,
    });

    const handler = buildHandler(panelManager);
    handler.indicatorFocused = true;
    handler.feed('\r'); // open + focus fleet

    expect(handler.prompt).toBe('');
    handler.feed('j');

    expect(stub.receivedKeys).toEqual(['j']);
    expect(handler.prompt).toBe(''); // 'j' did NOT leak into the composer
  });
});
