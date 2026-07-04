// ---------------------------------------------------------------------------
// fleet-panel.test.ts
// W2.2 — FleetPanel interaction: navigate/detail/kill-confirm flow with a
// stub read-model + stub action callbacks (no live runtime/registry).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
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
    capabilities: { interruptible: true, killable: true, pausable: false },
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
// Enter — detail focus (Wave-3 seam)
// ---------------------------------------------------------------------------

describe('FleetPanel — Enter sets detail focus', () => {
  test('Enter on a real selection sets isDetailFocused() true and consumes the key', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([makeNode({ id: 'only' })], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.isDetailFocused()).toBe(false);
    const consumed = panel.handleInput('enter');
    expect(consumed).toBe(true);
    expect(panel.isDetailFocused()).toBe(true);
  });

  test('Enter with no selection is unconsumed (returns false)', () => {
    const readModel = createStaticFleetReadModel(buildFleetSnapshot([], NOW));
    const panel = new FleetPanel(readModel);
    expect(panel.handleInput('enter')).toBe(false);
    expect(panel.isDetailFocused()).toBe(false);
  });

  test('the Wave-3 session-tab-attach seam comment is present at the Enter branch (not removed)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../../panels/fleet-panel.ts'), 'utf8');
    expect(source).toContain('Wave 3: attach session tab here');
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
