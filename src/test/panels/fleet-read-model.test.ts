// ---------------------------------------------------------------------------
// fleet-read-model.test.ts
// — fleet read-model: tree building from flat ProcessNode[], sorting,
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
  isBlockedOnUserState,
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
    capabilities: { interruptible: true, killable: true, pausable: false, steerable: false },
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

  // -------------------------------------------------------------------------
  // Leaf-only aggregation (bug fix): a wrfc-chain node's usage/costUsd is the
  // SDK's OWN rollup of its member agents (see wrfc.ts adaptChain / registry.ts
  // assemble()), and those same member agents ALSO appear individually in the
  // flat node list. Summing over every flat node therefore double-counts —
  // the chain total gets added ON TOP of the totals its own members already
  // contribute. Same story for a completed WRFC owner agent: the SDK backfills
  // owner.usage from aggregateChainUsage(chain) (wrfc-controller.ts
  // completeOwnerAgent), which is the SAME phase-children total the chain node
  // (and the phase children themselves) already carry.
  // -------------------------------------------------------------------------

  test('a wrfc-chain node plus its two member agents contributes cost ONCE (the chain total), not chain+members', () => {
    const chain = makeNode({
      id: 'chain:c1',
      kind: 'wrfc-chain',
      costState: 'priced',
      costUsd: 0.345,
      usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 2, turnCount: 2, toolCallCount: 4 },
    });
    const memberA = makeNode({
      id: 'member-a',
      parentId: 'chain:c1',
      costState: 'priced',
      costUsd: 0.3,
      usage: { inputTokens: 600, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 2 },
    });
    const memberB = makeNode({
      id: 'member-b',
      parentId: 'chain:c1',
      costState: 'priced',
      costUsd: 0.045,
      usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 2 },
    });
    const snap = buildFleetSnapshot([chain, memberA, memberB], NOW);
    expect(snap.totalCost).toBeCloseTo(0.345, 10);
    expect(snap.totalTokens).toBe(1_200); // members only: (600+200) + (300+100), chain's own usage excluded
  });

  test('runningCount excludes the wrfc-chain rollup row itself — only its running members count', () => {
    const chain = makeNode({ id: 'chain:c1', kind: 'wrfc-chain', state: 'executing-tool' });
    const memberA = makeNode({ id: 'member-a', parentId: 'chain:c1', state: 'executing-tool' });
    const memberB = makeNode({ id: 'member-b', parentId: 'chain:c1', state: 'done' });
    const snap = buildFleetSnapshot([chain, memberA, memberB], NOW);
    expect(snap.runningCount).toBe(1);
  });

  test('a wrfc-subtask node never contributes usage/cost even if it somehow carried a priced reading', () => {
    const subtask = makeNode({
      id: 'subtask:s1',
      kind: 'wrfc-subtask',
      costState: 'priced',
      costUsd: 5, // hostile fixture: real subtasks never carry this, but the aggregator must not trust kind-mismatched data
    });
    const snap = buildFleetSnapshot([subtask], NOW);
    expect(snap.totalCost).toBeNull();
  });

  test('a completed WRFC owner agent (raw.wrfcRole === "owner") is excluded from cost/token totals — its usage is a rollup of its already-counted phase children', () => {
    const engineer = makeNode({
      id: 'engineer-1',
      parentId: 'chain:c2',
      costState: 'priced',
      costUsd: 0.2,
      usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1 },
    });
    const reviewer = makeNode({
      id: 'reviewer-1',
      parentId: 'chain:c2',
      costState: 'priced',
      costUsd: 0.1,
      usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1 },
    });
    // Owner: SDK-backfilled usage/cost === sum of engineer+reviewer (see
    // wrfc-controller.ts completeOwnerAgent -> aggregateChainUsage). raw
    // carries the AgentRecord shape (wrfcRole: 'owner') the SDK actually sets.
    const owner = makeNode({
      id: 'owner-1',
      kind: 'agent',
      state: 'done',
      costState: 'priced',
      costUsd: 0.3,
      usage: { inputTokens: 600, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 2, turnCount: 2, toolCallCount: 2 },
      raw: { wrfcRole: 'owner' },
    });
    const snap = buildFleetSnapshot([owner, engineer, reviewer], NOW);
    expect(snap.totalCost).toBeCloseTo(0.3, 10); // engineer(0.2) + reviewer(0.1), NOT +owner's duplicate 0.3
    expect(snap.totalTokens).toBe(750); // (400+100) + (200+50), owner's duplicate 750 excluded
  });

  test('a non-owner agent node (raw.wrfcRole is engineer/undefined/absent) still contributes normally', () => {
    const plain = makeNode({ id: 'plain-agent', costState: 'priced', costUsd: 0.1 });
    const engineer = makeNode({ id: 'eng', costState: 'priced', costUsd: 0.2, raw: { wrfcRole: 'engineer' } });
    const snap = buildFleetSnapshot([plain, engineer], NOW);
    expect(snap.totalCost).toBeCloseTo(0.3, 10);
  });
});

// ---------------------------------------------------------------------------
// State classification — glyph/tone/kind mapping
// ---------------------------------------------------------------------------

describe('fleetStateGlyph / fleetStateTone / isTerminalProcessState / isRunningProcessState', () => {
  test('every ProcessState maps to a distinct, non-empty glyph', () => {
    const states: ProcessState[] = [
      'thinking', 'executing-tool', 'awaiting-approval', 'streaming', 'stalled',
      'retrying', 'done', 'failed', 'killed', 'interrupted', 'idle', 'queued',
    ];
    const glyphs = states.map(fleetStateGlyph);
    expect(glyphs.every((g) => g.length > 0)).toBe(true);
    expect(new Set(glyphs).size).toBe(states.length);
  });

  test('terminal states', () => {
    expect(isTerminalProcessState('done')).toBe(true);
    expect(isTerminalProcessState('failed')).toBe(true);
    expect(isTerminalProcessState('killed')).toBe(true);
    expect(isTerminalProcessState('interrupted')).toBe(true);
    expect(isTerminalProcessState('executing-tool')).toBe(false);
    expect(isTerminalProcessState('idle')).toBe(false);
    expect(isTerminalProcessState('queued')).toBe(false);
  });

  test('running states', () => {
    for (const s of ['thinking', 'executing-tool', 'awaiting-approval', 'streaming', 'stalled', 'retrying'] as ProcessState[]) {
      expect(isRunningProcessState(s)).toBe(true);
    }
    for (const s of ['done', 'failed', 'killed', 'interrupted', 'idle', 'queued'] as ProcessState[]) {
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

  // 'interrupted' is a distinct terminal outcome
  // from 'killed' — both come from AgentManager.cancel(), but a graceful
  // interrupt is display-distinguishable from a hard kill (the replay-found
  // defect this item fixes: before this, both landed on 'killed'/⊘).
  test("'interrupted' has a glyph and tone distinct from 'killed' and 'failed'", () => {
    expect(fleetStateGlyph('interrupted')).not.toBe(fleetStateGlyph('killed'));
    expect(fleetStateGlyph('interrupted')).not.toBe(fleetStateGlyph('failed'));
    expect(fleetStateTone('interrupted')).toBe('warn');
    expect(fleetStateTone('interrupted')).not.toBe(fleetStateTone('killed'));
    expect(fleetStateTone('interrupted')).not.toBe(fleetStateTone('failed'));
  });

  test('fleetKindTag returns a short tag for every ProcessKind', () => {
    const kinds = [
      'agent', 'wrfc-chain', 'wrfc-subtask', 'workflow', 'trigger', 'schedule', 'watcher', 'background-process',
      // Orchestration-engine kinds.
      'workstream', 'phase', 'work-item',
      // The repo source-tree code index.
      'code-index',
    ] as const;
    for (const k of kinds) {
      expect(fleetKindTag(k).length).toBeGreaterThan(0);
    }
    // Compile-forced exhaustiveness lives in KIND_TAGS' Record<ProcessKind, string>
    // itself; this just double-checks every one of those 12 kinds actually
    // resolves to a real tag (not the '?? kind' fallback) at runtime too.
    expect(new Set(kinds.map(fleetKindTag)).size).toBe(kinds.length);
  });

  test("fleetKindTag('code-index') is a distinct, short tag", () => {
    expect(fleetKindTag('code-index')).toBe('index');
  });
});

// ---------------------------------------------------------------------------
// 'code-index' is a leaf node, not a rollup: it has no
// children in the flat list, reports no usage/cost (an index build has no
// LLM turn), but DOES count toward runningCount while building — it is a
// real, distinct unit of work, not an arithmetic sum of other rows.
// ---------------------------------------------------------------------------

describe("buildFleetSnapshot — 'code-index' leaf node", () => {
  test('a building code-index node counts toward runningCount and contributes no cost/tokens (it reports none)', () => {
    const node = makeNode({
      id: 'code-index:main',
      kind: 'code-index',
      state: 'executing-tool',
      costState: 'unpriced',
      costUsd: null,
      usage: undefined,
      capabilities: { interruptible: false, killable: false, pausable: false, steerable: false },
    });
    const snapshot = buildFleetSnapshot([node]);
    expect(snapshot.runningCount).toBe(1);
    expect(snapshot.totalCost).toBeNull();
    expect(snapshot.totalTokens).toBeNull();
  });

  test('an idle/done code-index node does not count toward runningCount', () => {
    const node = makeNode({ id: 'code-index:main', kind: 'code-index', state: 'idle' });
    const snapshot = buildFleetSnapshot([node]);
    expect(snapshot.runningCount).toBe(0);
  });

  test('renders as a standalone root row with no children (no tree-nesting code needed)', () => {
    const node = makeNode({ id: 'code-index:main', kind: 'code-index', state: 'done' });
    const rows = buildFleetRows([node]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[0]!.hasChildren).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// orchestration-engine kinds: workstream/phase double-count
// exclusion (adaptWorkstream sums every work-item once; adaptPhase reports
// nothing), work-item leaf inclusion (it carries its own direct usage/cost),
// and buildFleetRows nesting workstream -> phase -> work-item -> agent.
// ---------------------------------------------------------------------------

describe('buildFleetSnapshot — workstream/phase/work-item rollup', () => {
  function makeUsage(inputTokens: number, outputTokens: number) {
    return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 1 };
  }

  test('a workstream node plus its work items contributes cost/tokens ONCE (the workstream total), not workstream+items', () => {
    const workstream = makeNode({
      id: 'workstream:w1',
      kind: 'workstream',
      costState: 'priced',
      costUsd: 0.5,
      usage: makeUsage(900, 300),
    });
    const itemA = makeNode({
      id: 'work-item:i1',
      kind: 'work-item',
      parentId: 'workstream:w1',
      costState: 'priced',
      costUsd: 0.3,
      usage: makeUsage(600, 200),
    });
    const itemB = makeNode({
      id: 'work-item:i2',
      kind: 'work-item',
      parentId: 'workstream:w1',
      costState: 'priced',
      costUsd: 0.2,
      usage: makeUsage(300, 100),
    });
    const snap = buildFleetSnapshot([workstream, itemA, itemB], NOW);
    expect(snap.totalCost).toBeCloseTo(0.5, 10);
    expect(snap.totalTokens).toBe(1_200); // items only: (600+200)+(300+100); workstream's own rolled-up usage excluded
  });

  test('a phase node never contributes usage/cost even if it somehow carried a priced reading', () => {
    const phase = makeNode({
      id: 'phase:w1:p1',
      kind: 'phase',
      parentId: 'workstream:w1',
      costState: 'priced',
      costUsd: 9, // hostile fixture: real phases never carry this (adaptPhase always reports null/unpriced)
    });
    const snap = buildFleetSnapshot([phase], NOW);
    expect(snap.totalCost).toBeNull();
  });

  test('a work-item leaf DOES contribute its own usage/cost — it is not a rollup kind', () => {
    const item = makeNode({
      id: 'work-item:solo',
      kind: 'work-item',
      costState: 'priced',
      costUsd: 0.75,
      usage: makeUsage(400, 100),
    });
    const snap = buildFleetSnapshot([item], NOW);
    expect(snap.totalCost).toBe(0.75);
    expect(snap.totalTokens).toBe(500);
  });

  test('runningCount excludes the workstream and phase rollup rows — only the running work-item (or its agent) counts', () => {
    const workstream = makeNode({ id: 'workstream:w1', kind: 'workstream', state: 'executing-tool' });
    const phase = makeNode({ id: 'phase:w1:p1', kind: 'phase', parentId: 'workstream:w1', state: 'executing-tool' });
    const item = makeNode({ id: 'work-item:i1', kind: 'work-item', parentId: 'phase:w1:p1', state: 'executing-tool' });
    const snap = buildFleetSnapshot([workstream, phase, item], NOW);
    expect(snap.runningCount).toBe(1);
  });

  test('buildFleetRows nests workstream -> phase -> work-item -> agent via parentId, with zero new tree code', () => {
    const nodes = [
      makeNode({ id: 'workstream:w1', kind: 'workstream', startedAt: NOW - 10_000 }),
      makeNode({ id: 'phase:w1:p1', kind: 'phase', parentId: 'workstream:w1', startedAt: NOW - 9_000 }),
      makeNode({ id: 'work-item:i1', kind: 'work-item', parentId: 'phase:w1:p1', startedAt: NOW - 8_000 }),
      makeNode({ id: 'agent-1', kind: 'agent', parentId: 'work-item:i1', startedAt: NOW - 7_000 }),
    ];
    const rows = buildFleetRows(nodes);
    const byId = new Map(rows.map((r) => [r.node.id, r]));
    expect(byId.get('workstream:w1')!.depth).toBe(0);
    expect(byId.get('phase:w1:p1')!.depth).toBe(1);
    expect(byId.get('work-item:i1')!.depth).toBe(2);
    expect(byId.get('agent-1')!.depth).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createFleetReadModel / createStaticFleetReadModel
// ---------------------------------------------------------------------------

describe('createFleetReadModel', () => {
  function makeRegistry(nodes: ProcessNode[]): FleetRegistryLike & {
    interruptCalls: string[];
    resumeCalls: string[];
    killCalls: Array<{ id: string; opts: unknown }>;
    steerCalls: Array<{ id: string; text: string }>;
  } {
    const interruptCalls: string[] = [];
    const resumeCalls: string[] = [];
    const killCalls: Array<{ id: string; opts: unknown }> = [];
    const steerCalls: Array<{ id: string; text: string }> = [];
    const listeners = new Set<(snap: { capturedAt: number; nodes: readonly ProcessNode[] }) => void>();
    return {
      resume: (id: string) => { resumeCalls.push(id); return true; },
      resumeCalls,
      query: () => ({ capturedAt: NOW, nodes }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      interrupt: (id: string) => { interruptCalls.push(id); return true; },
      kill: (id: string, opts?: { cascade?: boolean }) => { killCalls.push({ id, opts }); return [id]; },
      steer: (id: string, text: string) => { steerCalls.push({ id, text }); return { queued: true, messageId: 'msg-1' }; },
      interruptCalls,
      killCalls,
      steerCalls,
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

  test('resume (d2) delegates to the underlying registry', () => {
    const registry = makeRegistry([]);
    const model = createFleetReadModel(registry);
    expect(model.resume('sched-x')).toBe(true);
    expect(registry.resumeCalls).toEqual(['sched-x']);
  });

  test('steer delegates to the underlying registry', () => {
    const registry = makeRegistry([]);
    const model = createFleetReadModel(registry);
    expect(model.steer('agent-x', 'hello')).toEqual({ queued: true, messageId: 'msg-1' });
    expect(registry.steerCalls).toEqual([{ id: 'agent-x', text: 'hello' }]);
  });

  test('steer passes the SDK\'s wake-retry result (woke: true) straight through — this read model needs no change for steer-wake', () => {
    // ProcessRegistry.steer() now wake-retries a stalled node internally (SDK
    // 1.6.1's agent-experience round) and reports it via SteerResult.woke.
    // The TUI's fleet read model is a pure passthrough to registry.steer() —
    // pin that the extra field survives instead of being dropped by an
    // exact-shape reconstruction somewhere in the plumbing.
    const registry = makeRegistry([]);
    registry.steer = (id: string, text: string) => {
      registry.steerCalls.push({ id, text });
      return { queued: true, messageId: 'msg-woke-1', woke: true };
    };
    const model = createFleetReadModel(registry);
    expect(model.steer('agent-stalled', 'still there?')).toEqual({ queued: true, messageId: 'msg-woke-1', woke: true });
  });

  test('subscribeConsumed without a runtimeBus dep is a graceful no-op (never invokes the listener)', () => {
    const registry = makeRegistry([]);
    const model = createFleetReadModel(registry);
    const unsub = model.subscribeConsumed(() => { throw new Error('must not be called'); });
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  test('subscribeConsumed forwards COMMUNICATION_CONSUMED envelopes from the communication domain, filtering out other event types', () => {
    const registry = makeRegistry([]);
    type Listener = (envelope: { payload: { type: string; messageId?: string; agentId?: string; turn?: number } }) => void;
    const domainListeners = new Set<Listener>();
    const runtimeBus = {
      onDomain: (domain: string, cb: Listener) => {
        expect(domain).toBe('communication');
        domainListeners.add(cb);
        return () => domainListeners.delete(cb);
      },
    };
    const model = createFleetReadModel(registry, runtimeBus as never);
    const received: Array<{ messageId: string; agentId: string; turn: number }> = [];
    model.subscribeConsumed((event) => received.push(event));

    // A non-consumed communication event (e.g. COMMUNICATION_SENT) must be filtered out.
    for (const cb of domainListeners) cb({ payload: { type: 'COMMUNICATION_SENT' } });
    expect(received).toHaveLength(0);

    for (const cb of domainListeners) {
      cb({ payload: { type: 'COMMUNICATION_CONSUMED', messageId: 'm1', agentId: 'agent-x', turn: 3 } });
    }
    expect(received).toEqual([{ messageId: 'm1', agentId: 'agent-x', turn: 3 }]);
  });
});

describe('createStaticFleetReadModel', () => {
  test('getSnapshot always returns the fixed snapshot', () => {
    const snapshot = buildFleetSnapshot([makeNode({ id: 'static-01' })], NOW);
    const model = createStaticFleetReadModel(snapshot);
    expect(model.getSnapshot()).toBe(snapshot);
    expect(model.getSnapshot()).toBe(snapshot); // stable across calls
  });

  test('subscribe/interrupt/kill/steer/subscribeConsumed are no-ops that never throw', () => {
    const snapshot = buildFleetSnapshot([], NOW);
    const model = createStaticFleetReadModel(snapshot);
    const unsub = model.subscribe(() => { throw new Error('must not be called'); });
    expect(() => unsub()).not.toThrow();
    expect(model.interrupt('x')).toBe(false);
    expect(model.resume('x')).toBe(false);
    expect(model.kill('x', { cascade: true })).toEqual([]);
    expect(model.steer('x', 'hello')).toEqual({ queued: false, reason: 'no live registry' });
    const unsubConsumed = model.subscribeConsumed(() => { throw new Error('must not be called'); });
    expect(() => unsubConsumed()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// d4: /schedule AutomationManager jobs surface in the fleet tree as
// 'schedule'-kind nodes with the automation-manager source marker. The SDK's
// adaptAutomationJob (platform/runtime/fleet/adapters/automation.ts) produces
// the ProcessNode; this mirrors its exact documented output (a job created via
// /schedule IS a schedule from the user's viewpoint) and proves the TUI
// read-model surfaces it correctly — kind 'schedule', 'sched' tag, disabled ->
// 'paused' + resumable, and the raw.source marker that distinguishes it from a
// workflow-tool ScheduleEntry sharing the same kind.
// ---------------------------------------------------------------------------

/** Mirror of the SDK adaptAutomationJob output (not cleanly re-exported from the fleet index, so replicated here from its verified source shape). */
function adaptedAutomationJobNode(job: { id: string; name: string; prompt: string; enabled: boolean }): ProcessNode {
  return {
    id: `automation-job:${job.id}`,
    kind: 'schedule',
    parentId: undefined,
    label: job.name,
    task: job.prompt,
    state: (job.enabled ? 'idle' : 'paused') as ProcessState,
    elapsedMs: 0,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: job.enabled, resumable: !job.enabled, steerable: false },
    raw: { source: 'automation-manager', job },
  } as ProcessNode;
}

describe('automation-sourced schedule node (d4)', () => {
  test('a disabled /schedule job surfaces as a paused, resumable "schedule" node with the automation-manager source marker', () => {
    const node = adaptedAutomationJobNode({ id: 'nightly', name: 'nightly digest', prompt: 'summarize', enabled: false });
    const snapshot = buildFleetSnapshot([node], NOW);
    const row = snapshot.rows.find((r) => r.node.id === 'automation-job:nightly');
    expect(row).toBeDefined();
    expect(row!.node.kind).toBe('schedule');
    expect(fleetKindTag(row!.node.kind)).toBe('sched');
    expect(row!.node.state).toBe('paused');
    expect(row!.node.capabilities.resumable).toBe(true);
    // The source marker distinguishes an automation job from a workflow-tool
    // ScheduleEntry that shares the 'schedule' kind (isAutomationJobRaw's check).
    expect((row!.node.raw as { source?: string }).source).toBe('automation-manager');
  });

  test('an enabled /schedule job surfaces as an idle, pausable "schedule" node', () => {
    const node = adaptedAutomationJobNode({ id: 'hourly', name: 'hourly sync', prompt: 'sync', enabled: true });
    const rows = buildFleetRows([node]);
    const surfaced = rows.find((r) => r.node.id === 'automation-job:hourly');
    expect(surfaced).toBeDefined();
    expect(surfaced!.node.kind).toBe('schedule');
    expect(surfaced!.node.state).toBe('idle');
    expect(surfaced!.node.capabilities.pausable).toBe(true);
    expect(surfaced!.node.capabilities.resumable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blocked-on-me — derived "waiting on the user" state (never a stored flag)
// ---------------------------------------------------------------------------

describe('isBlockedOnUserState', () => {
  test('awaiting-approval is blocked on the user', () => {
    expect(isBlockedOnUserState('awaiting-approval')).toBe(true);
  });
  test('other states are not blocked on the user', () => {
    for (const s of ['thinking', 'executing-tool', 'streaming', 'stalled', 'retrying', 'done', 'idle', 'paused'] as ProcessState[]) {
      expect(isBlockedOnUserState(s)).toBe(false);
    }
  });
});

describe('blocked-on-me sorting + snapshot ids', () => {
  test('a blocked root sorts above an earlier-started non-blocked root', () => {
    const nodes = [
      makeNode({ id: 'busy', state: 'executing-tool', startedAt: NOW - 10_000 }),
      makeNode({ id: 'waiting', state: 'awaiting-approval', startedAt: NOW - 1_000 }),
    ];
    const rows = buildFleetRows(nodes);
    // 'waiting' floats to the top despite starting later.
    expect(rows.map((r) => r.node.id)).toEqual(['waiting', 'busy']);
  });

  test('a family leading to a blocked descendant floats up, tree structure intact', () => {
    const nodes = [
      makeNode({ id: 'root-a', state: 'executing-tool', startedAt: NOW - 20_000 }),
      makeNode({ id: 'root-b', state: 'executing-tool', startedAt: NOW - 10_000 }),
      makeNode({ id: 'b-child', parentId: 'root-b', state: 'awaiting-approval', startedAt: NOW - 5_000 }),
    ];
    const rows = buildFleetRows(nodes);
    // root-b's subtree contains the blocked child, so root-b sorts above root-a,
    // and its child still renders directly beneath it at depth 1.
    expect(rows.map((r) => r.node.id)).toEqual(['root-b', 'b-child', 'root-a']);
    expect(rows[1]!.depth).toBe(1);
  });

  test('blocked siblings sort above non-blocked siblings under the same parent', () => {
    const nodes = [
      makeNode({ id: 'root', state: 'executing-tool', startedAt: NOW - 30_000 }),
      makeNode({ id: 'c-busy', parentId: 'root', state: 'executing-tool', startedAt: NOW - 20_000 }),
      makeNode({ id: 'c-waiting', parentId: 'root', state: 'awaiting-approval', startedAt: NOW - 1_000 }),
    ];
    const rows = buildFleetRows(nodes);
    expect(rows.map((r) => r.node.id)).toEqual(['root', 'c-waiting', 'c-busy']);
  });

  test('snapshot.blockedNodeIds lists blocked nodes in display order; empty when none', () => {
    const nodes = [
      makeNode({ id: 'busy', state: 'executing-tool', startedAt: NOW - 10_000 }),
      makeNode({ id: 'w1', state: 'awaiting-approval', startedAt: NOW - 2_000 }),
      makeNode({ id: 'w2', state: 'awaiting-approval', startedAt: NOW - 1_000 }),
    ];
    const snap = buildFleetSnapshot(nodes, NOW);
    expect(snap.blockedNodeIds).toEqual(['w1', 'w2']);

    const none = buildFleetSnapshot([makeNode({ id: 'busy', state: 'executing-tool' })], NOW);
    expect(none.blockedNodeIds).toEqual([]);
  });
});
