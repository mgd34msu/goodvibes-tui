// ---------------------------------------------------------------------------
// fleet-read-model.test.ts
// W2.2 — fleet read-model: tree building from flat ProcessNode[], sorting,
// tree-prefix correctness, cycle guard, state glyph/tone mapping, and honest
// cost/token aggregation (never a fabricated $0.00/0-token reading).
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import type { ProcessNode, ProcessState } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import {
  buildFleetRows,
  buildFleetSnapshot,
  createFleetReadModel,
  createStaticFleetReadModel,
  fleetKindTag,
  fleetStateGlyph,
  fleetStateTone,
  fleetUsageTokens,
  hasFleetCost,
  hasFleetUsage,
  isRunningProcessState,
  isTerminalProcessState,
  type FleetRegistryLike,
} from '../../panels/fleet-read-model.ts';

const NOW = 1_700_000_000_000;

function makeNode(overrides: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent',
    label: overrides.id,
    state: 'executing-tool',
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildFleetRows — tree building
// ---------------------------------------------------------------------------

describe('buildFleetRows — tree shape', () => {
  test('empty input yields empty rows', () => {
    expect(buildFleetRows([])).toHaveLength(0);
  });

  test('single root has depth 0 and empty treePrefix', () => {
    const rows = buildFleetRows([makeNode({ id: 'a' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[0]!.treePrefix).toBe('');
    expect(rows[0]!.hasChildren).toBe(false);
  });

  test('roots are ordered by startedAt ascending, then id', () => {
    const nodes = [
      makeNode({ id: 'later', startedAt: NOW - 1_000 }),
      makeNode({ id: 'earlier', startedAt: NOW - 5_000 }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(['earlier', 'later']);
  });

  test('nodes without startedAt sort after nodes with a startedAt', () => {
    const nodes = [
      makeNode({ id: 'no-start' }),
      makeNode({ id: 'has-start', startedAt: NOW }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(['has-start', 'no-start']);
  });

  test('a single child gets the last-child connector and depth 1', () => {
    const nodes = [
      makeNode({ id: 'root', startedAt: NOW - 10_000 }),
      makeNode({ id: 'child', parentId: 'root', startedAt: NOW - 5_000 }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(2);
    const child = rows.find((r) => r.node.id === 'child')!;
    expect(child.depth).toBe(1);
    expect(child.treePrefix).toBe('└─ ');
    expect(child.isLastChild).toBe(true);
  });

  test('multiple children get mid (├─ ) and last (└─ ) connectors', () => {
    const nodes = [
      makeNode({ id: 'root', startedAt: NOW - 10_000 }),
      makeNode({ id: 'child-a', parentId: 'root', startedAt: NOW - 8_000 }),
      makeNode({ id: 'child-b', parentId: 'root', startedAt: NOW - 6_000 }),
      makeNode({ id: 'child-c', parentId: 'root', startedAt: NOW - 4_000 }),
    ];
    const rows = buildFleetRows(nodes);
    const byId = new Map(rows.map((r) => [r.node.id, r]));
    expect(byId.get('child-a')!.treePrefix).toBe('├─ ');
    expect(byId.get('child-a')!.isLastChild).toBe(false);
    expect(byId.get('child-b')!.treePrefix).toBe('├─ ');
    expect(byId.get('child-c')!.treePrefix).toBe('└─ ');
    expect(byId.get('child-c')!.isLastChild).toBe(true);
  });

  test('grandchild indent uses │  under a mid-child and spaces under a last-child', () => {
    const nodes = [
      makeNode({ id: 'root', startedAt: NOW - 10_000 }),
      makeNode({ id: 'mid', parentId: 'root', startedAt: NOW - 8_000 }),
      makeNode({ id: 'last', parentId: 'root', startedAt: NOW - 6_000 }),
      makeNode({ id: 'grand-under-mid', parentId: 'mid', startedAt: NOW - 7_000 }),
      makeNode({ id: 'grand-under-last', parentId: 'last', startedAt: NOW - 5_000 }),
    ];
    const rows = buildFleetRows(nodes);
    const byId = new Map(rows.map((r) => [r.node.id, r]));
    expect(byId.get('grand-under-mid')!.depth).toBe(2);
    expect(byId.get('grand-under-mid')!.treePrefix).toBe('│  └─ ');
    expect(byId.get('grand-under-last')!.treePrefix).toBe('   └─ ');
  });

  test('multiple independent roots each render without a connector to each other', () => {
    const nodes = [
      makeNode({ id: 'root-a', startedAt: NOW - 10_000 }),
      makeNode({ id: 'root-b', startedAt: NOW - 5_000 }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows.every((r) => r.depth === 0 && r.treePrefix === '')).toBe(true);
  });

  test('self-referencing parentId does not infinite-loop and the node still appears exactly once', () => {
    const nodes = [makeNode({ id: 'loopy', parentId: 'loopy' })];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.node.id).toBe('loopy');
  });

  test('a two-node parentId cycle does not infinite-loop and both nodes appear exactly once', () => {
    const nodes = [
      makeNode({ id: 'cycle-a', parentId: 'cycle-b' }),
      makeNode({ id: 'cycle-b', parentId: 'cycle-a' }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.node.id))).toEqual(new Set(['cycle-a', 'cycle-b']));
  });

  test('a parentId pointing at a non-existent node is treated as a root', () => {
    const nodes = [makeNode({ id: 'orphan', parentId: 'does-not-exist' })];
    const rows = buildFleetRows(nodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[0]!.treePrefix).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildFleetSnapshot — honest cost/token aggregates
// ---------------------------------------------------------------------------

describe('buildFleetSnapshot — honest cost/token aggregates', () => {
  test('empty input yields null totals and zero runningCount', () => {
    const snap = buildFleetSnapshot([], NOW);
    expect(snap.rows).toHaveLength(0);
    expect(snap.totalCost).toBeNull();
    expect(snap.totalTokens).toBeNull();
    expect(snap.runningCount).toBe(0);
    expect(snap.capturedAt).toBe(NOW);
  });

  test('a node with zero-usage (present but all-zero) contributes null, not 0 tokens', () => {
    const node = makeNode({
      id: 'zero-usage',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0 },
    });
    expect(hasFleetUsage(node.usage)).toBe(false);
    expect(fleetUsageTokens(node.usage)).toBeNull();
    const snap = buildFleetSnapshot([node]);
    expect(snap.totalTokens).toBeNull();
  });

  test('a node with real usage contributes its token total', () => {
    const node = makeNode({
      id: 'real-usage',
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1 },
    });
    expect(fleetUsageTokens(node.usage)).toBe(1_250);
    const snap = buildFleetSnapshot([node]);
    expect(snap.totalTokens).toBe(1_250);
  });

  test('unpriced costState never contributes to totalCost even when costUsd happens to be a number', () => {
    // Defensive: the SDK contract says costUsd is null when unpriced, but the
    // aggregate must honor costState as the source of truth regardless.
    const node = makeNode({ id: 'unpriced', costState: 'unpriced', costUsd: 0 });
    expect(hasFleetCost(node.costUsd, node.costState)).toBe(false);
    const snap = buildFleetSnapshot([node]);
    expect(snap.totalCost).toBeNull();
  });

  test('a priced node contributes its costUsd to totalCost', () => {
    const node = makeNode({ id: 'priced', costState: 'priced', costUsd: 0.5 });
    expect(hasFleetCost(node.costUsd, node.costState)).toBe(true);
    const snap = buildFleetSnapshot([node]);
    expect(snap.totalCost).toBe(0.5);
  });

  test('mixed priced + unpriced: total reflects only the priced node', () => {
    const nodes = [
      makeNode({ id: 'priced', costState: 'priced', costUsd: 0.3 }),
      makeNode({ id: 'unpriced', costState: 'unpriced', costUsd: null }),
    ];
    const snap = buildFleetSnapshot(nodes);
    expect(snap.totalCost).toBe(0.3);
  });

  test('an estimated costState with a numeric costUsd counts toward the total', () => {
    const node = makeNode({ id: 'estimated', costState: 'estimated', costUsd: 1.2 });
    const snap = buildFleetSnapshot([node]);
    expect(snap.totalCost).toBe(1.2);
  });

  test('runningCount counts only actively-working states', () => {
    const nodes: ProcessNode[] = [
      makeNode({ id: 'a', state: 'thinking' }),
      makeNode({ id: 'b', state: 'executing-tool' }),
      makeNode({ id: 'c', state: 'streaming' }),
      makeNode({ id: 'd', state: 'done' }),
      makeNode({ id: 'e', state: 'idle' }),
      makeNode({ id: 'f', state: 'queued' }),
    ];
    const snap = buildFleetSnapshot(nodes);
    expect(snap.runningCount).toBe(3);
  });

  test('elapsedMs is read verbatim from the node, never recomputed from a wall-clock now', () => {
    const node = makeNode({ id: 'pinned', elapsedMs: 123_456 });
    const snapA = buildFleetSnapshot([node], NOW);
    const snapB = buildFleetSnapshot([node], NOW + 999_999);
    expect(snapA.rows[0]!.node.elapsedMs).toBe(123_456);
    expect(snapB.rows[0]!.node.elapsedMs).toBe(123_456);
  });
});

// ---------------------------------------------------------------------------
// State classification — glyph/tone/kind mapping
// ---------------------------------------------------------------------------

describe('fleetStateGlyph / fleetStateTone / isTerminalProcessState / isRunningProcessState', () => {
  test('every ProcessState maps to a distinct, non-empty glyph', () => {
    const states: ProcessState[] = [
      'thinking', 'executing-tool', 'awaiting-approval', 'streaming', 'stalled',
      'retrying', 'done', 'failed', 'killed', 'idle', 'queued',
    ];
    const glyphs = states.map(fleetStateGlyph);
    expect(glyphs.every((g) => g.length > 0)).toBe(true);
    expect(new Set(glyphs).size).toBe(states.length);
  });

  test('terminal states', () => {
    expect(isTerminalProcessState('done')).toBe(true);
    expect(isTerminalProcessState('failed')).toBe(true);
    expect(isTerminalProcessState('killed')).toBe(true);
    expect(isTerminalProcessState('executing-tool')).toBe(false);
    expect(isTerminalProcessState('idle')).toBe(false);
    expect(isTerminalProcessState('queued')).toBe(false);
  });

  test('running states', () => {
    for (const s of ['thinking', 'executing-tool', 'awaiting-approval', 'streaming', 'stalled', 'retrying'] as ProcessState[]) {
      expect(isRunningProcessState(s)).toBe(true);
    }
    for (const s of ['done', 'failed', 'killed', 'idle', 'queued'] as ProcessState[]) {
      expect(isRunningProcessState(s)).toBe(false);
    }
  });

  test('tone mapping is consistent with terminal/running classification', () => {
    expect(fleetStateTone('done')).toBe('success');
    expect(fleetStateTone('failed')).toBe('failure');
    expect(fleetStateTone('killed')).toBe('muted');
    expect(fleetStateTone('idle')).toBe('muted');
    expect(fleetStateTone('queued')).toBe('muted');
    expect(['active', 'warn']).toContain(fleetStateTone('executing-tool'));
  });

  test('fleetKindTag returns a short tag for every ProcessKind', () => {
    const kinds = ['agent', 'wrfc-chain', 'wrfc-subtask', 'workflow', 'trigger', 'schedule', 'watcher', 'background-process'] as const;
    for (const k of kinds) {
      expect(fleetKindTag(k).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// createFleetReadModel / createStaticFleetReadModel
// ---------------------------------------------------------------------------

describe('createFleetReadModel', () => {
  function makeRegistry(nodes: ProcessNode[]): FleetRegistryLike & { interruptCalls: string[]; killCalls: Array<{ id: string; opts: unknown }> } {
    const interruptCalls: string[] = [];
    const killCalls: Array<{ id: string; opts: unknown }> = [];
    const listeners = new Set<(snap: { capturedAt: number; nodes: readonly ProcessNode[] }) => void>();
    return {
      query: () => ({ capturedAt: NOW, nodes }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      interrupt: (id: string) => { interruptCalls.push(id); return true; },
      kill: (id: string, opts?: { cascade?: boolean }) => { killCalls.push({ id, opts }); return [id]; },
      interruptCalls,
      killCalls,
    };
  }

  test('getSnapshot delegates to registry.query() and builds the tree', () => {
    const registry = makeRegistry([makeNode({ id: 'live-01' })]);
    const model = createFleetReadModel(registry);
    const snap = model.getSnapshot();
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]!.node.id).toBe('live-01');
    expect(snap.capturedAt).toBe(NOW);
  });

  test('subscribe delegates to registry.subscribe and returns an unsubscribe function', () => {
    const registry = makeRegistry([]);
    const model = createFleetReadModel(registry);
    let calls = 0;
    const unsub = model.subscribe(() => { calls++; });
    expect(typeof unsub).toBe('function');
    unsub();
  });

  test('interrupt/kill delegate to the underlying registry', () => {
    const registry = makeRegistry([]);
    const model = createFleetReadModel(registry);
    expect(model.interrupt('agent-x')).toBe(true);
    expect(registry.interruptCalls).toEqual(['agent-x']);
    expect(model.kill('agent-x', { cascade: true })).toEqual(['agent-x']);
    expect(registry.killCalls).toEqual([{ id: 'agent-x', opts: { cascade: true } }]);
  });
});

describe('createStaticFleetReadModel', () => {
  test('getSnapshot always returns the fixed snapshot', () => {
    const snapshot = buildFleetSnapshot([makeNode({ id: 'static-01' })], NOW);
    const model = createStaticFleetReadModel(snapshot);
    expect(model.getSnapshot()).toBe(snapshot);
    expect(model.getSnapshot()).toBe(snapshot); // stable across calls
  });

  test('subscribe/interrupt/kill are no-ops that never throw', () => {
    const snapshot = buildFleetSnapshot([], NOW);
    const model = createStaticFleetReadModel(snapshot);
    const unsub = model.subscribe(() => { throw new Error('must not be called'); });
    expect(() => unsub()).not.toThrow();
    expect(model.interrupt('x')).toBe(false);
    expect(model.kill('x', { cascade: true })).toEqual([]);
  });
});
