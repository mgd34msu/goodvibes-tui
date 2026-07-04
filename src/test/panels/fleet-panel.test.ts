// ---------------------------------------------------------------------------
// fleet-panel.test.ts
// W2.2 — FleetPanel interaction: navigate/detail/kill-confirm flow with a
// stub read-model + stub action callbacks (no live runtime/registry).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { FleetPanel, type FleetActionCallbacks } from '../../panels/fleet-panel.ts';
import {
  buildFleetSnapshot,
  createStaticFleetReadModel,
  type FleetReadModel,
  type FleetSnapshot,
} from '../../panels/fleet-read-model.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { Line } from '../../types/grid.ts';

const NOW = 1_700_000_000_000;

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

function makeNode(overrides: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent',
    label: overrides.id,
    state: 'executing-tool',
    elapsedMs: 1_000,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    ...overrides,
  };
}

/** Mutable stub read-model: getSnapshot re-reads a swappable ref; subscribe listeners are invoked manually to simulate a registry tick. */
function makeMutableReadModel(initial: FleetSnapshot): {
  model: FleetReadModel;
  setSnapshot: (s: FleetSnapshot) => void;
  fireDirty: () => void;
  fireConsumed: (event: { messageId: string; agentId: string; turn: number }) => void;
} {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const consumedListeners = new Set<(event: { messageId: string; agentId: string; turn: number }) => void>();
  return {
    model: {
      getSnapshot: () => snapshot,
      subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
      interrupt: () => false,
      resume: () => false,
      kill: () => [],
      steer: () => ({ queued: false, reason: 'not wired in this test' }),
      subscribeConsumed: (cb) => { consumedListeners.add(cb); return () => consumedListeners.delete(cb); },
    },
    setSnapshot: (s: FleetSnapshot) => { snapshot = s; },
    fireDirty: () => { for (const cb of listeners) cb(); },
    fireConsumed: (event) => { for (const cb of consumedListeners) cb(event); },
  };
}

function makeActions(overrides: Partial<FleetActionCallbacks> = {}): FleetActionCallbacks & {
  interruptCalls: string[];
  resumeCalls: string[];
  killCalls: Array<{ id: string; opts: { cascade: boolean } }>;
  steerCalls: Array<{ id: string; text: string }>;
} {
  const interruptCalls: string[] = [];
  const resumeCalls: string[] = [];
  const killCalls: Array<{ id: string; opts: { cascade: boolean } }> = [];
  const steerCalls: Array<{ id: string; text: string }> = [];
  return {
    interrupt: overrides.interrupt ?? ((id: string) => { interruptCalls.push(id); return true; }),
    resume: overrides.resume ?? ((id: string) => { resumeCalls.push(id); return true; }),
    kill: overrides.kill ?? ((id: string, opts: { cascade: boolean }) => { killCalls.push({ id, opts }); return [id]; }),
    getConversationSnapshot: overrides.getConversationSnapshot ?? ((_id: string): readonly ConversationMessageSnapshot[] => []),
    resolveSessionLogPath: overrides.resolveSessionLogPath ?? ((id: string) => id),
    steer: overrides.steer ?? ((id: string, text: string) => { steerCalls.push({ id, text }); return { queued: true, messageId: `msg-${steerCalls.length}` }; }),
    interruptCalls,
    resumeCalls,
    killCalls,
    steerCalls,
  };
}

/** Attach + focus a single steerable agent tab, ready for `s` to open the composer. */
function attachSteerableTab(actions = makeActions()) {
  const node = makeNode({
    id: 'agent-1',
    state: 'streaming',
    capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
  });
  const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
  const panel = new FleetPanel(readModel, actions);
  panel.handleInput('enter'); // attach + focus the tab
  return { panel, actions, readModel, node };
}

// ---------------------------------------------------------------------------
// Navigation — getSelectedItem(), never a raw index read
// ---------------------------------------------------------------------------

describe('FleetPanel — navigation', () => {
  test('j moves the selection down through the flattened tree (gutter marker follows the cursor)', () => {
    const nodes = [
      makeNode({ id: 'row-a', startedAt: NOW - 3_000 }),
      makeNode({ id: 'row-b', startedAt: NOW - 2_000 }),
      makeNode({ id: 'row-c', startedAt: NOW - 1_000 }),
    ];
    const readModel = createStaticFleetReadModel(buildFleetSnapshot(nodes, NOW));
    const panel = new FleetPanel(readModel);

    let text = linesText(panel.render(100, 24));
    let selected = text.split('\n').find((l) => l.includes('▸'));
    expect(selected).toContain('row-a');

    panel.handleInput('j');
    panel.handleInput('j');
    text = linesText(panel.render(100, 24));
    selected = text.split('\n').find((l) => l.includes('▸'));
    expect(selected).toContain('row-c');
  });

  test('k moves the selection back up', () => {
    const nodes = [
      makeNode({ id: 'row-a', startedAt: NOW - 3_000 }),
      makeNode({ id: 'row-b', startedAt: NOW - 2_000 }),
    ];
    const readModel = createStaticFleetReadModel(buildFleetSnapshot(nodes, NOW));
    const panel = new FleetPanel(readModel);

    panel.handleInput('j');
    let text = linesText(panel.render(100, 24));
    expect(text.split('\n').find((l) => l.includes('▸'))).toContain('row-b');

    panel.handleInput('k');
    text = linesText(panel.render(100, 24));
    expect(text.split('\n').find((l) => l.includes('▸'))).toContain('row-a');
  });

  test('empty fleet renders the empty-state message, not a crash', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('No processes tracked yet');
  });

  // W3.3 (cross-restart honesty) — no daemon bridge exists, so a TUI restart
  // never resurrects a prior session's processes into this tree; documented
  // in the empty state rather than silently doing nothing (design point 5).
  test('the empty state documents that a previous session\'s processes are not tracked here', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('previous sessions');
    expect(text).toContain('resets on TUI restart');
  });
});

// ---------------------------------------------------------------------------
// Enter — attach a session tab (Wave-3, W3.1 Part C)
// ---------------------------------------------------------------------------

describe('FleetPanel — Enter attaches a session tab', () => {
  test('Enter on an attachable (agent) node opens a tab, focuses it, and consumes the key', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-only' })], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.isTabActive()).toBe(false);
    const consumed = panel.handleInput('enter');
    expect(consumed).toBe(true);
    expect(panel.isTabActive()).toBe(true);
    const state = panel.getTabsState();
    expect(state.activeTabIndex).toBe(1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.nodeId).toBe('agent-only');
    expect(state.tabs[0]!.agentId).toBe('agent-only');
  });

  test('Enter on an attachable wrfc-chain node opens a tab with an empty agentId (no single conversation)', () => {
    const node = makeNode({ id: 'chain-1', kind: 'wrfc-chain' });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    panel.handleInput('enter');
    const state = panel.getTabsState();
    expect(state.tabs[0]!.kind).toBe('wrfc-chain');
    expect(state.tabs[0]!.agentId).toBe('');
  });

  test('Enter twice on the same node re-focuses the existing tab instead of duplicating it', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-only' })], NOW));
    const panel = new FleetPanel(readModel);
    panel.handleInput('enter');
    panel.handleInput('enter');
    expect(panel.getTabsState().tabs).toHaveLength(1);
    expect(panel.getTabsState().activeTabIndex).toBe(1);
  });

  test('Enter on a non-attachable node (e.g. watcher) is consumed, shows a status message, and does not open a tab', () => {
    const node = makeNode({
      id: 'watch-1',
      kind: 'watcher',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.handleInput('enter')).toBe(true);
    expect(panel.isTabActive()).toBe(false);
    expect(panel.getTabsState().tabs).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('has no transcript to attach');
  });

  test('Enter with no selection is unconsumed (returns false)', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.handleInput('enter')).toBe(false);
    expect(panel.isTabActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tab lifecycle — attach / switch / detach (Wave-3, W3.1 Part C)
// ---------------------------------------------------------------------------

describe('FleetPanel — session tab lifecycle', () => {
  test('] and [ switch focus between attached tabs and back to the root tree', () => {
    const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
    const readModel = createStaticFleetReadModel(buildFleetSnapshot(nodes, NOW));
    const panel = new FleetPanel(readModel);

    panel.handleInput('enter'); // attach 'a' -> activeTabIndex 1
    expect(panel.getTabsState().activeTabIndex).toBe(1);

    // Switch back to the root tree WITHOUT detaching 'a' to attach the second node too.
    expect(panel.handleInput('[')).toBe(true);
    expect(panel.getTabsState().activeTabIndex).toBe(0);
    expect(panel.getTabsState().tabs).toHaveLength(1); // 'a' is still attached, just not focused
    panel.handleInput('j'); // select 'b'
    panel.handleInput('enter'); // attach 'b' -> tabs=[a,b], activeTabIndex 2
    expect(panel.getTabsState().tabs.map((t) => t.nodeId)).toEqual(['a', 'b']);
    expect(panel.getTabsState().activeTabIndex).toBe(2);

    expect(panel.handleInput('[')).toBe(true);
    expect(panel.getTabsState().activeTabIndex).toBe(1);
    expect(panel.handleInput('[')).toBe(true);
    expect(panel.getTabsState().activeTabIndex).toBe(0);
    expect(panel.isTabActive()).toBe(false);

    expect(panel.handleInput(']')).toBe(true);
    expect(panel.getTabsState().activeTabIndex).toBe(1);
  });

  test('[ ] are unconsumed (return false) while the root tree is focused', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a' })], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.handleInput('[')).toBe(false);
    expect(panel.handleInput(']')).toBe(false);
  });

  test('interceptPanelClose() detaches the active tab and returns true; the underlying process is untouched', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    panel.handleInput('enter');
    expect(panel.isTabActive()).toBe(true);

    expect(panel.interceptPanelClose()).toBe(true);
    expect(panel.isTabActive()).toBe(false);
    expect(panel.getTabsState().tabs).toHaveLength(0);
    expect(actions.interruptCalls).toHaveLength(0);
    expect(actions.killCalls).toHaveLength(0);
  });

  test('interceptPanelClose() on the root tree returns false (falls through to panel-close)', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a' })], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.isTabActive()).toBe(false);
    expect(panel.interceptPanelClose()).toBe(false);
  });

  test('detaching a tab disposes its line cache (no retained rendered lines after detach)', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'streaming' })], NOW));
    const actions = makeActions({
      getConversationSnapshot: () => [{ role: 'user', content: 'hello' }],
    });
    const panel = new FleetPanel(readModel, actions);
    panel.handleInput('enter');
    panel.render(100, 24); // populate the tab's line cache
    const tab = panel.getTabsState().tabs[0]!;
    expect(tab.lineCache.size).toBeGreaterThan(0);
    panel.interceptPanelClose();
    expect(tab.lineCache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Transcript rendering — running (live) vs completed (frozen) vs evicted
// (ledger fallback), per a stub snapshot source (Wave-3, W3.1 Part C6)
// ---------------------------------------------------------------------------

describe('FleetPanel — tab transcript rendering', () => {
  test('a running agent renders its live snapshot content', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'streaming' })], NOW));
    const actions = makeActions({
      getConversationSnapshot: (id) => (id === 'a' ? [{ role: 'user', content: 'hello there' }] : []),
    });
    const panel = new FleetPanel(readModel, actions);
    panel.handleInput('enter');
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('hello there');
  });

  test('a completed agent with a non-empty (frozen) snapshot still renders full content', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'done' })], NOW));
    const actions = makeActions({
      getConversationSnapshot: (id) => (id === 'a' ? [{ role: 'user', content: 'frozen content' }] : []),
    });
    const panel = new FleetPanel(readModel, actions);
    panel.handleInput('enter');
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('frozen content');
  });

  // W3.3 — done/dead process browsability. Every terminal state (not just
  // 'done') must attach a READ-ONLY tab: no i/K while a tab is focused
  // (handleInput's activeTabIndex>0 branch returns false for tree-only keys
  // regardless of tab kind), and the content itself is honestly labeled as a
  // static, non-live view rather than looking indistinguishable from a
  // running agent's tab.
  describe('terminal-state (done/failed/killed/interrupted) agent nodes attach read-only tabs', () => {
    for (const state of ['done', 'failed', 'killed', 'interrupted'] as const) {
      test(`Enter on a '${state}' agent node attaches a tab (wo611's Enter path already permits terminal-node attach)`, () => {
        const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state })], NOW));
        const actions = makeActions({
          getConversationSnapshot: (id) => (id === 'a' ? [{ role: 'user', content: `content for ${state}` }] : []),
        });
        const panel = new FleetPanel(readModel, actions);
        expect(panel.handleInput('enter')).toBe(true);
        expect(panel.isTabActive()).toBe(true);
        const text = linesText(panel.render(100, 24));
        expect(text).toContain(`content for ${state}`);
        expect(text).toContain('Read-only'); // honest static-transcript notice (design point 4)
      });
    }

    test('i and K are never consumed while a terminal agent\'s tab is focused (no interrupt/kill surface on a read-only view)', () => {
      const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'done' })], NOW));
      const actions = makeActions({ getConversationSnapshot: () => [{ role: 'user', content: 'x' }] });
      const panel = new FleetPanel(readModel, actions);
      panel.handleInput('enter');
      expect(panel.isTabActive()).toBe(true);
      expect(panel.handleInput('i')).toBe(false);
      expect(panel.handleInput('K')).toBe(false);
      expect(actions.interruptCalls).toHaveLength(0);
      expect(actions.killCalls).toHaveLength(0);
    });

    test('a live (non-terminal) agent\'s tab does NOT carry the read-only notice', () => {
      const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'streaming' })], NOW));
      const actions = makeActions({ getConversationSnapshot: () => [{ role: 'user', content: 'still going' }] });
      const panel = new FleetPanel(readModel, actions);
      panel.handleInput('enter');
      const text = linesText(panel.render(100, 24));
      expect(text).toContain('still going');
      expect(text).not.toContain('Read-only');
    });
  });

  test('a completed agent with an empty (evicted) snapshot falls back to the ledger view', async () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a', state: 'done' })], NOW));
    const actions = makeActions({
      getConversationSnapshot: () => [],
      resolveSessionLogPath: () => '/nonexistent/path/for/testing/a.jsonl',
    });
    const panel = new FleetPanel(readModel, actions);
    panel.handleInput('enter');
    // First render kicks off the (failing) async ledger read; content is a
    // loading placeholder until the promise settles.
    let text = linesText(panel.render(100, 24));
    expect(text).toContain('Loading');
    await new Promise((resolve) => setTimeout(resolve, 20));
    text = linesText(panel.render(100, 24));
    expect(text).toContain('Full transcript unavailable');
  });

  test('a wrfc-chain tab renders a live member summary, not a transcript', () => {
    const owner = makeNode({ id: 'chain-1', kind: 'wrfc-chain', state: 'executing-tool' });
    const member = makeNode({ id: 'member-1', parentId: 'chain-1', kind: 'agent', label: 'Engineer', state: 'streaming' });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([owner, member], NOW));
    const panel = new FleetPanel(readModel);
    panel.handleInput('enter'); // attaches the chain (first row)
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Engineer');
  });
});

// ---------------------------------------------------------------------------
// Backpressure — only the FOCUSED tab renders a transcript; per-tab caches
// are isolated from each other and from switching (Wave-3, W3.1 Part C5)
// ---------------------------------------------------------------------------

describe('FleetPanel — per-tab cache isolation (backpressure)', () => {
  test('switching tabs does not clear a background tab\'s cache, and each tab has its own MessageLineCache instance', () => {
    const nodes = [makeNode({ id: 'a', state: 'streaming' }), makeNode({ id: 'b', state: 'streaming' })];
    const readModel = createStaticFleetReadModel(buildFleetSnapshot(nodes, NOW));
    const actions = makeActions({
      getConversationSnapshot: (id) => [{ role: 'user', content: `content for ${id}` }],
    });
    const panel = new FleetPanel(readModel, actions);

    panel.handleInput('enter'); // attach + focus 'a'
    panel.render(100, 24);
    const tabA = panel.getTabsState().tabs[0]!;
    expect(tabA.lineCache.size).toBeGreaterThan(0);

    panel.handleInput('['); // back to root WITHOUT detaching 'a'
    panel.handleInput('j');
    panel.handleInput('enter'); // attach + focus 'b'
    panel.render(100, 24);
    const tabB = panel.getTabsState().tabs[1]!;
    expect(tabB.lineCache.size).toBeGreaterThan(0);
    expect(tabB.lineCache).not.toBe(tabA.lineCache);

    // 'a' is now a background tab (not focused) — its cache is untouched by
    // 'b' having rendered.
    expect(tabA.lineCache.size).toBeGreaterThan(0);

    panel.handleInput('[');
    expect(panel.getTabsState().activeTabIndex).toBe(1); // back to 'a'
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('content for a');
  });
});

// ---------------------------------------------------------------------------
// i — interrupt (real, non-terminal node only)
// ---------------------------------------------------------------------------

describe('FleetPanel — i interrupts the selected node', () => {
  test('i calls actions.interrupt with the selected node id', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-1', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('i')).toBe(true);
    expect(actions.interruptCalls).toEqual(['agent-1']);
  });

  test('i on an empty list is unconsumed and does not call interrupt', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('i')).toBe(false);
    expect(actions.interruptCalls).toHaveLength(0);
  });

  test('i on a terminal node is unconsumed and does not call interrupt', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'done-1', state: 'done' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('i')).toBe(false);
    expect(actions.interruptCalls).toHaveLength(0);
  });

  test('i on a non-terminal but non-interruptible node is consumed, shows a status message, and does not call interrupt', () => {
    // Realistic case: every fleet kind except 'agent' reports
    // capabilities.interruptible: false unconditionally (schedule/trigger/
    // watcher/workflow/wrfc-chain/wrfc-subtask/background-process — see the
    // SDK's fleet adapters), even while actively running.
    const node = makeNode({
      id: 'chain-1',
      kind: 'wrfc-chain',
      state: 'executing-tool',
      capabilities: { interruptible: false, killable: true, pausable: false, steerable: false },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('i')).toBe(true);
    expect(actions.interruptCalls).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('does not support interrupt');
  });
});

// ---------------------------------------------------------------------------
// K — kill confirm flow (PanelConfirmOverlay)
// ---------------------------------------------------------------------------

describe('FleetPanel — K arms a kill confirm', () => {
  test('K arms the confirm overlay; kill is not called until confirmed', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-k', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    expect(panel.handleInput('K')).toBe(true);
    expect(actions.killCalls).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('Kill');
  });

  test('y confirms the kill with cascade:true', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-k', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    panel.handleInput('K');
    panel.handleInput('y');
    expect(actions.killCalls).toEqual([{ id: 'agent-k', opts: { cascade: true } }]);
  });

  test('Enter also confirms the kill', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-k', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    panel.handleInput('K');
    panel.handleInput('enter');
    expect(actions.killCalls).toEqual([{ id: 'agent-k', opts: { cascade: true } }]);
  });

  test('Esc dismisses the confirm without calling kill', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-k', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    panel.handleInput('K');
    panel.handleInput('escape');
    expect(actions.killCalls).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('Kill "');
  });

  test('n dismisses the confirm without calling kill', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-k', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    panel.handleInput('K');
    panel.handleInput('n');
    expect(actions.killCalls).toHaveLength(0);
  });

  test('unrelated keys are absorbed while the confirm is pending', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'agent-k', state: 'streaming' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    panel.handleInput('K');
    for (const key of ['j', 'k', 'up', 'down', 'i', 'f', ' ']) {
      expect(panel.handleInput(key)).toBe(true);
    }
    expect(actions.killCalls).toHaveLength(0);

    // Confirm still pending — y still fires.
    panel.handleInput('y');
    expect(actions.killCalls).toEqual([{ id: 'agent-k', opts: { cascade: true } }]);
  });

  test('K on an empty list is unconsumed and does not arm a confirm', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('K')).toBe(false);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('Kill "');
  });

  test('K on a terminal node is unconsumed and does not arm a confirm', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'done-1', state: 'failed' })], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('K')).toBe(false);
    expect(actions.killCalls).toHaveLength(0);
  });

  test('K on a non-terminal but non-killable node is consumed, shows a status message, and does not arm a confirm', () => {
    const node = makeNode({
      id: 'watch-1',
      kind: 'watcher',
      state: 'idle',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('K')).toBe(true);
    expect(actions.killCalls).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('Kill "');
    expect(text).toContain('does not support kill');
  });

  // UX-C item 6: a cascade kill (actions.kill(id, { cascade: true })) takes
  // down every non-terminal descendant regardless of that node's OWN
  // `killable` capability — the old count only tallied `capabilities.killable`
  // descendants ("active leaves"), so a 6-node non-terminal subtree with only
  // 2 individually-killable nodes reported "(+2 children)" — the evaluator's
  // exact finding. It must now report the FULL count that will actually die,
  // plus how many of those are individually killable.
  test('K arms a confirm phrased "(+N descendants, M active)" counting the FULL non-terminal subtree, not just individually-killable nodes', () => {
    const root = makeNode({ id: 'root-1', state: 'executing-tool', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const childA = makeNode({ id: 'child-a', parentId: 'root-1', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const childB = makeNode({ id: 'child-b', parentId: 'root-1', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const childC = makeNode({ id: 'child-c', parentId: 'root-1', kind: 'watcher', state: 'idle', capabilities: { interruptible: false, killable: false, pausable: false, steerable: false } });
    const childD = makeNode({ id: 'child-d', parentId: 'root-1', state: 'executing-tool', capabilities: { interruptible: false, killable: false, pausable: false, steerable: false } });
    const grandchild1 = makeNode({ id: 'grandchild-1', parentId: 'child-a', state: 'streaming', capabilities: { interruptible: false, killable: false, pausable: false, steerable: false } });
    const grandchild2 = makeNode({ id: 'grandchild-2', parentId: 'child-c', state: 'streaming', capabilities: { interruptible: false, killable: false, pausable: false, steerable: false } });
    // An already-terminal descendant does NOT count — it is already dead, a
    // cascade kill has nothing to do to it.
    const terminalChild = makeNode({ id: 'terminal-child', parentId: 'root-1', state: 'failed', capabilities: { interruptible: false, killable: true, pausable: false, steerable: false } });

    const readModel = createStaticFleetReadModel(buildFleetSnapshot(
      [root, childA, childB, childC, childD, grandchild1, grandchild2, terminalChild], NOW,
    ));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    expect(panel.handleInput('K')).toBe(true);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('+6 descendants, 2 active');

    panel.handleInput('y');
    expect(actions.killCalls).toEqual([{ id: 'root-1', opts: { cascade: true } }]);
  });

  test('K on a node with exactly one non-terminal descendant uses the singular "descendant" (no "active" pluralization issue either)', () => {
    const root = makeNode({ id: 'root-1', state: 'executing-tool', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const onlyChild = makeNode({ id: 'only-child', parentId: 'root-1', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([root, onlyChild], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);

    expect(panel.handleInput('K')).toBe(true);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('+1 descendant, 1 active');
    expect(text).not.toContain('descendants');
  });
});

// ---------------------------------------------------------------------------
// p — pause (Wave 4, wo703 B4 control parity). Reuses actions.interrupt
// verbatim, gated on capabilities.pausable instead of interruptible (which
// trigger/schedule always report false) — see fleet-panel.ts's handleInput
// doc comment for why no new action/registry plumbing was needed.
// ---------------------------------------------------------------------------

describe('FleetPanel — p pauses a pausable node', () => {
  test('p calls actions.interrupt (not a new pause action) with the selected node id', () => {
    const node = makeNode({
      id: 'trigger-1',
      kind: 'trigger',
      state: 'idle',
      capabilities: { interruptible: false, killable: true, pausable: true, steerable: false },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(true);
    expect(actions.interruptCalls).toEqual(['trigger-1']);
  });

  test('p on an empty list is unconsumed', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(false);
    expect(actions.interruptCalls).toHaveLength(0);
  });

  test('p on a terminal node is unconsumed and does not call interrupt', () => {
    const node = makeNode({
      id: 'trigger-done',
      kind: 'trigger',
      state: 'killed',
      capabilities: { interruptible: false, killable: true, pausable: true, steerable: false },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(false);
    expect(actions.interruptCalls).toHaveLength(0);
  });

  test('p on a non-pausable node is consumed, shows a status message, and does not call interrupt', () => {
    const node = makeNode({ id: 'agent-1', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(true);
    expect(actions.interruptCalls).toHaveLength(0);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('does not support pause');
  });

  test('the p footer hint shows only for a pausable, non-terminal node', () => {
    const pausable = makeNode({
      id: 'schedule-1',
      kind: 'schedule',
      state: 'idle',
      capabilities: { interruptible: false, killable: true, pausable: true, steerable: false },
    });
    const notPausable = makeNode({ id: 'agent-1', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    expect(linesText(new FleetPanel(createStaticFleetReadModel(buildFleetSnapshot([pausable], NOW))).render(100, 24))).toContain('p pause');
    expect(linesText(new FleetPanel(createStaticFleetReadModel(buildFleetSnapshot([notPausable], NOW))).render(100, 24))).not.toContain('p pause');
  });
});

// ---------------------------------------------------------------------------
// Wave 4 (wo703) fleet-tree nesting: workstream/phase render as honest,
// non-attachable aggregate nodes (Enter refuses with the same message as any
// other transcript-less kind); a work-item still delegates to its live agent
// for capabilities (per adaptWorkItem), but the node itself stays
// non-attachable (isAttachableFleetKind — see fleet-tabs.test.ts).
// ---------------------------------------------------------------------------

describe('FleetPanel — Enter on workstream/phase/work-item nodes (wo703)', () => {
  test('Enter on a workstream, phase, or work-item node refuses with the honest "no transcript" message', () => {
    for (const kind of ['workstream', 'phase', 'work-item'] as const) {
      const node = makeNode({ id: `node-${kind}`, kind, state: 'executing-tool' });
      const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
      const panel = new FleetPanel(readModel);
      expect(panel.handleInput('enter')).toBe(true);
      const text = linesText(panel.render(100, 24));
      expect(text).toContain('has no transcript to attach');
    }
  });
});

// ---------------------------------------------------------------------------
// s — steer composer (Wave-3, W3.2): one-line input on an active attached
// tab whose node is steerable. Capability-gated like i/K; submit calls
// actions.steer with the node id and typed text; refusal renders inline.
// ---------------------------------------------------------------------------

describe('FleetPanel — s opens the steer composer on an active, steerable tab', () => {
  test('s on a steerable tab opens the draft and isCapturingTextBurst() flips true', () => {
    const { panel } = attachSteerableTab();
    expect(panel.isCapturingTextBurst()).toBe(false);
    expect(panel.handleInput('s')).toBe(true);
    expect(panel.isCapturingTextBurst()).toBe(true);
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('');
  });

  test('s is unavailable (not even a hint) and not consumed as steer while the root tree is focused', () => {
    // 's' has no meaning on the root tree in this wave (composer only exists
    // on an attached tab) — it falls through to ordinary list handling.
    const node = makeNode({ id: 'agent-1', capabilities: { interruptible: true, killable: true, pausable: false, steerable: true } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('s steer');
  });

  test('s on a non-steerable tab sets an honest error and does not open the draft', () => {
    const node = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    panel.handleInput('enter');
    expect(panel.handleInput('s')).toBe(true);
    expect(panel.isCapturingTextBurst()).toBe(false);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('does not support steering');
  });

  test('s on a terminal node\'s tab sets an honest error and does not open the draft', () => {
    const node = makeNode({
      id: 'agent-1',
      state: 'done',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: true },
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    panel.handleInput('enter');
    expect(panel.handleInput('s')).toBe(true);
    expect(panel.isCapturingTextBurst()).toBe(false);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('does not support steering');
  });

  test('the s hint appears in the tab footer only when the live node is steerable', () => {
    const { panel } = attachSteerableTab();
    expect(linesText(panel.render(100, 24))).toContain('s steer');
  });

  test('typing then Enter calls actions.steer(nodeId, text) and sets a queued badge', () => {
    const { panel, actions } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'hello agent') panel.handleInput(ch);
    expect(panel.handleInput('enter')).toBe(true);
    expect(actions.steerCalls).toEqual([{ id: 'agent-1', text: 'hello agent' }]);
    expect(panel.isCapturingTextBurst()).toBe(false); // draft closed after submit
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBeNull();
    // queuedAt (epoch ms, set at submit time) drives reconcileSteerBadges'
    // TTL-expiry fallback — see fleet-steer.test.ts for that behavior;
    // asserted loosely here since the exact timestamp is not the point of
    // this test.
    expect(panel.getTabsState().tabs[0]!.steerBadge).toEqual({ messageId: 'msg-1', status: 'queued', queuedAt: expect.any(Number) });
  });

  test('Esc cancels the draft without calling steer, and returns focus to the tab without detaching', () => {
    const { panel, actions } = attachSteerableTab();
    panel.handleInput('s');
    panel.handleInput('h');
    expect(panel.handleInput('escape')).toBe(true);
    expect(actions.steerCalls).toHaveLength(0);
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBeNull();
    expect(panel.isTabActive()).toBe(true); // still attached to the tab, not detached
    expect(panel.getTabsState().tabs).toHaveLength(1);
  });

  test('backspace edits the draft before submit', () => {
    const { panel, actions } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'helpp') panel.handleInput(ch);
    panel.handleInput('backspace');
    panel.handleInput('enter');
    expect(actions.steerCalls).toEqual([{ id: 'agent-1', text: 'help' }]);
  });

  test('an empty (whitespace-only) submission is a no-op — does not call steer', () => {
    const { panel, actions } = attachSteerableTab();
    panel.handleInput('s');
    panel.handleInput(' ');
    panel.handleInput('enter');
    expect(actions.steerCalls).toHaveLength(0);
    expect(panel.getTabsState().tabs[0]!.steerBadge).toBeNull();
  });

  test('refusal (queued:false) renders the honest typed reason inline and sets no badge', () => {
    const actions = makeActions({ steer: () => ({ queued: false, reason: 'agent is retrying, try again shortly' }) });
    const { panel } = attachSteerableTab(actions);
    panel.handleInput('s');
    panel.handleInput('x');
    panel.handleInput('enter');
    expect(panel.getTabsState().tabs[0]!.steerBadge).toBeNull();
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('agent is retrying, try again shortly');
  });

  test('refusal PRESERVES the draft, states why, and suggests live steerable siblings (WO UX-A item 4)', () => {
    // Target refuses; a second agent IS steerable, so the error should keep the
    // typed text and point at the sibling instead of silently discarding the draft.
    const target = makeNode({ id: 'agent-1', label: 'Builder', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: true } });
    const sibling = makeNode({ id: 'agent-2', label: 'Reviewer', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: true } });
    const actions = makeActions({ steer: () => ({ queued: false, reason: 'agent is not active and cannot be steered' }) });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([target, sibling], NOW));
    const panel = new FleetPanel(readModel, actions);
    panel.handleInput('enter'); // attach the first (Builder) tab
    panel.handleInput('s');
    for (const ch of 'fix the bug') panel.handleInput(ch);
    panel.handleInput('enter');

    // Draft kept intact (composer still open with the text), no badge set.
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('fix the bug');
    expect(panel.getTabsState().tabs[0]!.steerBadge).toBeNull();
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('Draft kept');
    expect(text).toContain('Reviewer'); // the live steerable sibling is suggested
  });

  test('queued acknowledgment names the target and points at the ⧗ badge', () => {
    const { panel } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'do the thing') panel.handleInput(ch);
    panel.handleInput('enter');
    const text = linesText(panel.render(120, 24));
    expect(text).toContain('steer queued');
    expect(text).toContain('⧗'); // references the delivery-tracking badge glyph
  });
});

// ---------------------------------------------------------------------------
// Steer draft paste normalization (CR-separated paste): a pasted multi-line
// block arrives as literal \r/\n characters through the same per-char burst
// pipeline as ordinary typing (see Panel.isCapturingTextBurst) — they must
// normalize to a single collapsed space, never a raw control byte and never
// silently dropped/jammed together.
// ---------------------------------------------------------------------------

describe('FleetPanel — steer draft paste normalization', () => {
  test('a CR-separated paste collapses each break to a single space', () => {
    const { panel } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'first\rsecond\rthird') panel.handleInput(ch);
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('first second third');
  });

  test('a CRLF paste (\\r\\n) also collapses to a single space, not two', () => {
    const { panel } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'first\r\nsecond') panel.handleInput(ch);
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('first second');
  });

  test('repeated line breaks collapse to one space, never multiple', () => {
    const { panel } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'first\r\r\rsecond') panel.handleInput(ch);
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('first second');
  });

  test('a leading line break on an empty draft contributes nothing (no leading space)', () => {
    const { panel } = attachSteerableTab();
    panel.handleInput('s');
    panel.handleInput('\r');
    panel.handleInput('x');
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('x');
  });

  test('the submitted (post-normalization) text is what actions.steer receives — never a literal \\r', () => {
    const { panel, actions } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of 'line one\rline two') panel.handleInput(ch);
    panel.handleInput('enter');
    expect(actions.steerCalls).toEqual([{ id: 'agent-1', text: 'line one line two' }]);
  });
});

// ---------------------------------------------------------------------------
// Focus routing (W0.8): while composing, every key lands in the draft —
// never as tree/tab navigation or hotkeys (i/K/f/[/]/enter).
// ---------------------------------------------------------------------------

describe('FleetPanel — steer draft owns input while composing (W0.8 focus rule)', () => {
  test('j/k/i/K/s/[/] all get typed into the draft rather than acting as navigation/hotkeys', () => {
    const { panel, actions } = attachSteerableTab();
    panel.handleInput('s');
    for (const ch of ['j', 'k', 'i', 'K', 's', '[', ']']) {
      expect(panel.handleInput(ch)).toBe(true);
    }
    expect(panel.getTabsState().tabs[0]!.steerDraft).toBe('jkiKs[]');
    expect(actions.interruptCalls).toHaveLength(0);
    expect(actions.killCalls).toHaveLength(0);
    expect(actions.steerCalls).toHaveLength(0); // not yet submitted
    expect(panel.getTabsState().activeTabIndex).toBe(1); // no tab switch occurred
  });

  test('once the draft closes (submit or cancel), keys resume their ordinary meaning', () => {
    const { panel } = attachSteerableTab();
    panel.handleInput('s');
    panel.handleInput('hi');
    panel.handleInput('escape'); // cancel, back to ordinary tab-view input
    expect(panel.isCapturingTextBurst()).toBe(false);
    expect(panel.handleInput('[')).toBe(true); // tab-switch works again
    expect(panel.getTabsState().activeTabIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Steer badge lifecycle: queued -> consumed (COMMUNICATION_CONSUMED) and
// queued -> dropped (target goes terminal before consumption — the SDK
// emits no dropped/expired signal, so FleetPanel infers it itself).
// ---------------------------------------------------------------------------

describe('FleetPanel — steer badge lifecycle', () => {
  test('a matching COMMUNICATION_CONSUMED event flips queued -> consumed', () => {
    const node = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
    });
    const { model, fireConsumed } = makeMutableReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(model, actions);
    panel.handleInput('enter');
    panel.handleInput('s');
    panel.handleInput('h');
    panel.handleInput('enter');
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('queued');
    const messageId = panel.getTabsState().tabs[0]!.steerBadge!.messageId;

    fireConsumed({ messageId, agentId: 'agent-1', turn: 2 });
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('consumed');
  });

  test('a COMMUNICATION_CONSUMED event for a different messageId does not affect the badge', () => {
    const node = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
    });
    const { model, fireConsumed } = makeMutableReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(model, actions);
    panel.handleInput('enter');
    panel.handleInput('s');
    panel.handleInput('h');
    panel.handleInput('enter');
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('queued');

    fireConsumed({ messageId: 'not-the-one', agentId: 'agent-1', turn: 2 });
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('queued');
  });

  test('the target going terminal while queued resolves the badge to dropped, with a visible note', () => {
    const running = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
    });
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(buildFleetSnapshot([running], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(model, actions);
    panel.handleInput('enter');
    panel.handleInput('s');
    panel.handleInput('h');
    panel.handleInput('enter');
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('queued');

    const doneNode = makeNode({
      id: 'agent-1',
      state: 'done',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    });
    setSnapshot(buildFleetSnapshot([doneNode], NOW));
    fireDirty(); // simulates the registry's coalesced tick notifying the read-model

    const badge = panel.getTabsState().tabs[0]!.steerBadge;
    expect(badge?.status).toBe('dropped');
    expect(badge?.note).toContain('went done');
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('steer dropped');
  });

  test('a queued badge whose node disappears from the snapshot entirely also resolves to dropped', () => {
    const running = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
    });
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(buildFleetSnapshot([running], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(model, actions);
    panel.handleInput('enter');
    panel.handleInput('s');
    panel.handleInput('h');
    panel.handleInput('enter');

    setSnapshot(buildFleetSnapshot([], NOW)); // node pruned entirely
    fireDirty();

    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('dropped');
  });

  test('consumed-wins: a COMMUNICATION_CONSUMED arriving AFTER the badge was already inferred dropped (target went terminal) still upgrades it to consumed — the SDK\'s honest signal beats the TUI\'s own inference', () => {
    const running = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
    });
    const { model, setSnapshot, fireDirty, fireConsumed } = makeMutableReadModel(buildFleetSnapshot([running], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(model, actions);
    panel.handleInput('enter');
    panel.handleInput('s');
    panel.handleInput('h');
    panel.handleInput('enter');
    const messageId = panel.getTabsState().tabs[0]!.steerBadge!.messageId;
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('queued');

    // Target goes terminal before any consumed event arrives — the TUI
    // infers 'dropped' (risk #2's honest-but-possibly-wrong guess).
    const doneNode = makeNode({
      id: 'agent-1',
      state: 'done',
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    });
    setSnapshot(buildFleetSnapshot([doneNode], NOW));
    fireDirty();
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('dropped');

    // The real signal arrives late, still within the badge's short linger
    // window (it has not been cleared to null yet) — the truth wins.
    fireConsumed({ messageId, agentId: 'agent-1', turn: 3 });
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('consumed');
  });

  test('a badge already consumed is left alone by a second (duplicate) COMMUNICATION_CONSUMED event', () => {
    const node = makeNode({
      id: 'agent-1',
      state: 'streaming',
      capabilities: { interruptible: true, killable: true, pausable: false, steerable: true },
    });
    const { model, fireConsumed } = makeMutableReadModel(buildFleetSnapshot([node], NOW));
    const actions = makeActions();
    const panel = new FleetPanel(model, actions);
    panel.handleInput('enter');
    panel.handleInput('s');
    panel.handleInput('h');
    panel.handleInput('enter');
    const messageId = panel.getTabsState().tabs[0]!.steerBadge!.messageId;

    fireConsumed({ messageId, agentId: 'agent-1', turn: 2 });
    const firstResolvedAt = panel.getTabsState().tabs[0]!.steerBadge!.resolvedAt;
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('consumed');

    fireConsumed({ messageId, agentId: 'agent-1', turn: 3 }); // duplicate/late-retried event
    expect(panel.getTabsState().tabs[0]!.steerBadge?.status).toBe('consumed');
    expect(panel.getTabsState().tabs[0]!.steerBadge?.resolvedAt).toBe(firstResolvedAt); // untouched, not re-stamped
  });
});

// ---------------------------------------------------------------------------
// i/K hints only appear when the selected node's capabilities allow them
// ---------------------------------------------------------------------------

describe('FleetPanel — i/K footer hints are gated on capabilities', () => {
  test('both hints show for a node that supports interrupt and kill', () => {
    const node = makeNode({ id: 'agent-1', state: 'streaming', capabilities: { interruptible: true, killable: true, pausable: false, steerable: false } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('i interrupt');
    expect(text).toContain('K kill');
  });

  test('the i hint is omitted when the selected node cannot be interrupted', () => {
    const node = makeNode({ id: 'chain-1', kind: 'wrfc-chain', state: 'executing-tool', capabilities: { interruptible: false, killable: true, pausable: false, steerable: false } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('i interrupt');
    expect(text).toContain('K kill');
  });

  test('the K hint is omitted when the selected node cannot be killed', () => {
    const node = makeNode({ id: 'agent-1', state: 'streaming', capabilities: { interruptible: true, killable: false, pausable: false, steerable: false } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).toContain('i interrupt');
    expect(text).not.toContain('K kill');
  });

  test('both hints are omitted for a terminal node (neither affordance applies)', () => {
    const node = makeNode({ id: 'done-1', state: 'done', capabilities: { interruptible: false, killable: false, pausable: false, steerable: false } });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('i interrupt');
    expect(text).not.toContain('K kill');
    expect(text).toContain('f follow');
  });

  test('both hints are omitted with an empty fleet (no selection)', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const panel = new FleetPanel(readModel);
    const text = linesText(panel.render(100, 24));
    expect(text).not.toContain('i interrupt');
    expect(text).not.toContain('K kill');
  });
});

// ---------------------------------------------------------------------------
// f — follow toggle + auto-scroll to the newest running node
// ---------------------------------------------------------------------------

describe('FleetPanel — f toggles follow', () => {
  test('f toggles follow state (reflected in the footer hint)', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'a' })], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.isFollowing()).toBe(false);
    panel.handleInput('f');
    expect(panel.isFollowing()).toBe(true);
    panel.handleInput('f');
    expect(panel.isFollowing()).toBe(false);
  });

  test('with follow on, a newly-arrived running node pulls the selection on the next dirty notification', () => {
    const before = buildFleetSnapshot([
      makeNode({ id: 'old-running', state: 'streaming', startedAt: NOW - 5_000 }),
    ], NOW);
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(before);
    const panel = new FleetPanel(model);

    panel.handleInput('f'); // follow on — selects the only running row ('old-running')

    const after = buildFleetSnapshot([
      makeNode({ id: 'old-running', state: 'streaming', startedAt: NOW - 5_000 }),
      makeNode({ id: 'brand-new', state: 'thinking', startedAt: NOW - 100 }),
    ], NOW);
    setSnapshot(after);
    fireDirty(); // simulates the registry's coalesced tick notifying the read-model

    const text = linesText(panel.render(100, 24));
    const selectedLine = text.split('\n').find((l) => l.includes('brand-new'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain('▸');
  });

  test('without follow, a newly-arrived running node does NOT move the selection', () => {
    const before = buildFleetSnapshot([
      makeNode({ id: 'old-running', state: 'streaming', startedAt: NOW - 5_000 }),
    ], NOW);
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(before);
    const panel = new FleetPanel(model);
    // follow stays off

    const after = buildFleetSnapshot([
      makeNode({ id: 'old-running', state: 'streaming', startedAt: NOW - 5_000 }),
      makeNode({ id: 'brand-new', state: 'thinking', startedAt: NOW - 100 }),
    ], NOW);
    setSnapshot(after);
    fireDirty();

    const text = linesText(panel.render(100, 24));
    const selectedLine = text.split('\n').find((l) => l.includes('old-running'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain('▸');
  });
});

// ---------------------------------------------------------------------------
// Selection anchored to node.id across snapshot updates (bug fix): the old
// index-anchored selection silently landed on a different process when a
// node above the cursor left the snapshot, and vanished entirely (no row
// marked ▸) when the list shrank below the old selectedIndex, until the next
// keypress. Both must self-correct on the very next render.
// ---------------------------------------------------------------------------

describe('FleetPanel — selection is anchored to node.id, not index, across snapshot updates', () => {
  test('removal of a node above the cursor keeps the selection on the same node, not whatever now sits at the old index', () => {
    const before = buildFleetSnapshot([
      makeNode({ id: 'row-a', startedAt: NOW - 3_000 }),
      makeNode({ id: 'row-b', startedAt: NOW - 2_000 }),
      makeNode({ id: 'row-c', startedAt: NOW - 1_000 }),
    ], NOW);
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(before);
    const panel = new FleetPanel(model);

    panel.handleInput('j'); // select row-b (index 1)
    let text = linesText(panel.render(100, 24));
    expect(text.split('\n').find((l) => l.includes('▸'))).toContain('row-b');

    // row-a (above the cursor) leaves the snapshot — row-b is now at index 0.
    setSnapshot(buildFleetSnapshot([
      makeNode({ id: 'row-b', startedAt: NOW - 2_000 }),
      makeNode({ id: 'row-c', startedAt: NOW - 1_000 }),
    ], NOW));
    fireDirty();

    text = linesText(panel.render(100, 24));
    const selectedLine = text.split('\n').find((l) => l.includes('▸'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain('row-b');
    expect(selectedLine).not.toContain('row-c');
  });

  test('the list shrinking below the previously-selected index clamps to the nearest valid row immediately, without an extra keypress', () => {
    const before = buildFleetSnapshot([
      makeNode({ id: 'row-a', startedAt: NOW - 3_000 }),
      makeNode({ id: 'row-b', startedAt: NOW - 2_000 }),
      makeNode({ id: 'row-c', startedAt: NOW - 1_000 }),
    ], NOW);
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(before);
    const panel = new FleetPanel(model);

    panel.handleInput('j');
    panel.handleInput('j'); // select row-c (index 2)

    // Snapshot shrinks to a single node — the old index (2) is now out of bounds.
    setSnapshot(buildFleetSnapshot([
      makeNode({ id: 'row-a', startedAt: NOW - 3_000 }),
    ], NOW));
    fireDirty();

    const text = linesText(panel.render(100, 24));
    const selectedLine = text.split('\n').find((l) => l.includes('▸'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain('row-a');
  });

  test('an unrelated snapshot update (no add/remove) leaves the selection exactly where it was', () => {
    const before = buildFleetSnapshot([
      makeNode({ id: 'row-a', startedAt: NOW - 3_000 }),
      makeNode({ id: 'row-b', startedAt: NOW - 2_000 }),
    ], NOW);
    const { model, setSnapshot, fireDirty } = makeMutableReadModel(before);
    const panel = new FleetPanel(model);

    panel.handleInput('j'); // select row-b
    setSnapshot(buildFleetSnapshot([
      makeNode({ id: 'row-a', startedAt: NOW - 3_000, elapsedMs: 9_999 }),
      makeNode({ id: 'row-b', startedAt: NOW - 2_000, elapsedMs: 9_999 }),
    ], NOW));
    fireDirty();

    const text = linesText(panel.render(100, 24));
    expect(text.split('\n').find((l) => l.includes('▸'))).toContain('row-b');
  });
});

// ---------------------------------------------------------------------------
// Read-model subscription drives markDirty
// ---------------------------------------------------------------------------

describe('FleetPanel — read-model subscription', () => {
  test('a dirty notification from the read-model marks the panel for re-render', () => {
    const { model, fireDirty } = makeMutableReadModel(buildFleetSnapshot([], NOW));
    const panel = new FleetPanel(model);
    panel.needsRender = false;
    fireDirty();
    expect(panel.needsRender).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registration — icon uniqueness + resolves a FleetPanel instance
// ---------------------------------------------------------------------------

describe('FleetPanel — registration', () => {
  test("registers as 'fleet' so /panel open fleet resolves a real FleetPanel (not a phantom id)", () => {
    const manager = new PanelManager();
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    manager.registerType({
      id: 'fleet',
      name: 'Fleet',
      icon: '⊟',
      category: 'runtime-ops',
      description: 'Live fleet tree',
      factory: () => new FleetPanel(readModel),
    });

    const opened = manager.open('fleet');
    expect(opened).toBeInstanceOf(FleetPanel);
    expect(manager.getPanel('fleet')).toBe(opened);
  });

  test('registerType throws when another panel already owns the fleet icon (collision guard proves uniqueness is enforced)', () => {
    const manager = new PanelManager();
    manager.registerType({
      id: 'other-panel',
      name: 'Other',
      icon: '⊟',
      category: 'runtime-ops',
      description: 'Pre-existing owner of the glyph',
      factory: () => new FleetPanel(createStaticFleetReadModel(buildFleetSnapshot([], NOW))),
    });

    expect(() => manager.registerType({
      id: 'fleet',
      name: 'Fleet',
      icon: '⊟',
      category: 'runtime-ops',
      description: 'Live fleet tree',
      factory: () => new FleetPanel(createStaticFleetReadModel(buildFleetSnapshot([], NOW))),
    })).toThrow(/collides/);
  });
});

// ---------------------------------------------------------------------------
// W6.2 d1/d2 — pause/resume toggle wiring + the 'stopping…' write-window overlay
// through the real FleetPanel.handleInput/render (the logic itself is unit-
// tested in fleet-stop.test.ts; these prove the panel wires it end-to-end).
// ---------------------------------------------------------------------------

describe('FleetPanel — pause/resume + stopping (W6.2 d)', () => {
  function pausableSchedule(state: ProcessNode['state']) {
    return makeNode({
      id: 'sched-1',
      kind: 'schedule',
      state,
      capabilities: { interruptible: false, killable: true, pausable: state !== 'paused', resumable: state === 'paused', steerable: false } as ProcessNode['capabilities'],
    });
  }

  test('p on a live pausable schedule pauses it (interrupt) and the row shows the display-only "stopping…"', () => {
    const actions = makeActions();
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([pausableSchedule('idle')], NOW));
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(true);
    expect(actions.interruptCalls).toEqual(['sched-1']);
    expect(actions.resumeCalls).toEqual([]);
    expect(linesText(panel.render(100, 24))).toContain('stopping…');
  });

  test('p on a paused resumable schedule resumes it (no stopping overlay)', () => {
    const actions = makeActions();
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([pausableSchedule('paused')], NOW));
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(true);
    expect(actions.resumeCalls).toEqual(['sched-1']);
    expect(actions.interruptCalls).toEqual([]);
    expect(linesText(panel.render(100, 24))).not.toContain('stopping…');
  });

  test('p on a paused NON-resumable node is an honest refusal (no resume dispatched)', () => {
    const actions = makeActions();
    const node = makeNode({
      id: 'trig-1',
      kind: 'trigger',
      state: 'paused',
      capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false } as ProcessNode['capabilities'],
    });
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([node], NOW));
    const panel = new FleetPanel(readModel, actions);
    expect(panel.handleInput('p')).toBe(true); // consumed (with an inline error), not silently ignored
    expect(actions.resumeCalls).toEqual([]);
    expect(actions.interruptCalls).toEqual([]);
  });
});
