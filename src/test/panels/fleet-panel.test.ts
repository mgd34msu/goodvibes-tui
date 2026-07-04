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
function makeMutableReadModel(initial: FleetSnapshot): { model: FleetReadModel; setSnapshot: (s: FleetSnapshot) => void; fireDirty: () => void } {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    model: {
      getSnapshot: () => snapshot,
      subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
      interrupt: () => false,
      kill: () => [],
    },
    setSnapshot: (s: FleetSnapshot) => { snapshot = s; },
    fireDirty: () => { for (const cb of listeners) cb(); },
  };
}

function makeActions(overrides: Partial<FleetActionCallbacks> = {}): FleetActionCallbacks & { interruptCalls: string[]; killCalls: Array<{ id: string; opts: { cascade: boolean } }> } {
  const interruptCalls: string[] = [];
  const killCalls: Array<{ id: string; opts: { cascade: boolean } }> = [];
  return {
    interrupt: overrides.interrupt ?? ((id: string) => { interruptCalls.push(id); return true; }),
    kill: overrides.kill ?? ((id: string, opts: { cascade: boolean }) => { killCalls.push({ id, opts }); return [id]; }),
    getConversationSnapshot: overrides.getConversationSnapshot ?? ((_id: string): readonly ConversationMessageSnapshot[] => []),
    resolveSessionLogPath: overrides.resolveSessionLogPath ?? ((id: string) => id),
    interruptCalls,
    killCalls,
  };
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
