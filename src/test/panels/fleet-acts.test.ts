// ---------------------------------------------------------------------------
// fleet-acts.test.ts, the Fleet panel's waiting-on-human acts round-trip
// against a mocked daemon, never typing an id:
//   • pick    , a flagged workstream row lists candidates (fleet.attempts.list),
//     the operator chooses a winner by navigation, and Enter drives
//     fleet.attempts.pick preview (confirm:false) -> confirm (confirm:true)
//     through the shared DiffPanel confirm overlay.
//   • conflict, a flagged work-item row runs fleet.conflicts.resolve and hands
//     the STAMPED session id to the shared jump/attach affordance; the failure
//     path renders an honest error.
//   • discard , a worktree-owning row runs worktrees.discard behind a confirm
//     and renders the honest receipt (branch kept, preservation commit).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { WorkItem } from '@pellux/goodvibes-sdk/platform/orchestration';
import {
  FleetActs,
  heldCandidates,
  workItemFromNode,
  type FleetDiffSurface,
} from '../../panels/fleet-acts.ts';
import {
  workItemIdFromNodeId,
  workstreamIdFromNodeId,
  type FleetAttemptCandidate,
  type FleetConflictResolution,
  type FleetGateway,
  type FleetHeldMergeGroup,
  type FleetPickResult,
  type FleetWorktreeDiscardReceipt,
} from '../../panels/fleet-gateway.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

function candidate(overrides: Partial<FleetAttemptCandidate> & { itemId: string; attemptIndex: number }): FleetAttemptCandidate {
  return {
    state: 'held-merge',
    title: `attempt ${overrides.attemptIndex + 1}`,
    worktreePath: `/wt/${overrides.itemId}`,
    branch: `gv/${overrides.itemId}`,
    failureReason: null,
    usage: {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 0,
      costUsd: 0.01, costState: 'priced',
    },
    diff: { files: [`file-${overrides.itemId}.ts`], unifiedDiff: `--- a\n+++ b\n@@ -1 +1 @@\n-old ${overrides.itemId}\n+new ${overrides.itemId}`, stat: '1 file' },
    ...overrides,
  };
}

function group(overrides: Partial<FleetHeldMergeGroup> & { groupId: string }): FleetHeldMergeGroup {
  return {
    workstreamId: 'ws-1',
    sourceTitle: 'implement the parser',
    ready: true,
    autoAccept: false,
    judgment: null,
    candidates: [
      candidate({ itemId: 'it-a', attemptIndex: 0 }),
      candidate({ itemId: 'it-b', attemptIndex: 1 }),
    ],
    ...overrides,
  };
}

function workstreamNode(id: string): ProcessNode {
  return {
    id: `workstream:${id}`, kind: 'workstream', label: 'stream', state: 'awaiting-approval',
    elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: false, steerable: false, resumable: false },
    needsAttention: { reason: 'pick' },
  };
}

function conflictNode(itemId: string, files: readonly string[]): ProcessNode {
  const item = { id: itemId, title: 'conflicted item', mergeState: 'conflict', conflictFiles: files, worktreePath: `/wt/${itemId}`, worktreeBranch: `gv/${itemId}` } as unknown as WorkItem;
  return {
    id: `work-item:${itemId}`, kind: 'work-item', label: 'item', state: 'stalled',
    elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: false, steerable: false, resumable: false },
    needsAttention: { reason: 'conflict' },
    raw: { item, workstreamId: 'ws-1' },
  };
}

function worktreeNode(itemId: string, worktreePath: string): ProcessNode {
  const item = { id: itemId, title: 'item', worktreePath, worktreeBranch: `gv/${itemId}` } as unknown as WorkItem;
  return {
    id: `work-item:${itemId}`, kind: 'work-item', label: 'item', state: 'done',
    elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, steerable: false, resumable: false },
    raw: { item, workstreamId: 'ws-1' },
  };
}

interface GatewayLog {
  listAttempts: string[];
  pick: Array<{ groupId: string; winnerItemId: string; confirm: boolean }>;
  resolveConflict: string[];
  discardWorktree: string[];
  armed: string[];
}

function makeGateway(opts: {
  groups?: FleetHeldMergeGroup[];
  pickResult?: (input: { groupId: string; winnerItemId: string; confirm: boolean }) => FleetPickResult;
  resolve?: () => FleetConflictResolution;
  resolveThrows?: Error;
  discard?: () => FleetWorktreeDiscardReceipt;
} = {}): { gateway: FleetGateway; log: GatewayLog } {
  const log: GatewayLog = { listAttempts: [], pick: [], resolveConflict: [], discardWorktree: [], armed: [] };
  const gateway: FleetGateway = {
    async listAttempts(workstreamId) { log.listAttempts.push(workstreamId); return { groups: opts.groups ?? [group({ groupId: 'g-1' })] }; },
    async pick(input) {
      log.pick.push(input);
      if (opts.pickResult) return opts.pickResult(input);
      return { applied: input.confirm, groupId: input.groupId, winnerItemId: input.winnerItemId, loserItemIds: input.confirm ? ['it-b'] : [], auto: false, requiresConfirm: !input.confirm } as FleetPickResult;
    },
    async resolveConflict(itemId) {
      log.resolveConflict.push(itemId);
      if (opts.resolveThrows) throw opts.resolveThrows;
      return opts.resolve ? opts.resolve() : { itemId, sessionId: `sess-${itemId}`, worktreePath: `/wt/${itemId}`, files: ['a.ts'] } as FleetConflictResolution;
    },
    async discardWorktree(path) {
      log.discardWorktree.push(path);
      return opts.discard ? opts.discard() : { path, ok: true, branch: 'gv/it-a', preservedCommit: 'abc1234', discardedAt: Date.now(), detail: 'directory removed; branch kept' } as FleetWorktreeDiscardReceipt;
    },
    armFixSessionAttach(sessionId) { log.armed.push(sessionId); },
    async getGraph() { throw new Error('makeGateway: getGraph is not exercised by these acts tests'); },
    async steerObserved() { throw new Error('makeGateway: steerObserved is not exercised by these acts tests'); },
  };
  return { gateway, log };
}

interface DiffLog { shown: Array<{ title: string; diff: string }>; confirms: Array<Parameters<FleetDiffSurface['armConfirm']>[0]>; closed: number; }
function makeDiffSurface(): { surface: FleetDiffSurface; log: DiffLog } {
  const log: DiffLog = { shown: [], confirms: [], closed: 0 };
  const surface: FleetDiffSurface = {
    show: (title, diff) => { log.shown.push({ title, diff }); },
    armConfirm: (opts) => { log.confirms.push(opts); },
    close: () => { log.closed += 1; },
  };
  return { surface, log };
}

function makeActs(gateway: FleetGateway, surface: FleetDiffSurface) {
  const notes: string[] = [];
  const acts = new FleetActs({
    resolveGateway: () => ({ available: true, gateway }),
    diffSurface: surface,
    notify: (m) => notes.push(m),
    markDirty: () => {},
    findNode: () => null,
  });
  return { acts, notes };
}

// ── pure helpers ──────────────────────────────────────────────────────────

describe('fleet-gateway id extraction (no id ever typed)', () => {
  test('workstream / work-item node ids strip to their raw ids', () => {
    expect(workstreamIdFromNodeId('workstream:ws-42')).toBe('ws-42');
    expect(workstreamIdFromNodeId('work-item:it-1')).toBeNull();
    expect(workItemIdFromNodeId('work-item:it-1')).toBe('it-1');
    expect(workItemIdFromNodeId('agent:a1')).toBeNull();
  });

  test('heldCandidates keeps only held attempts, in attempt order', () => {
    const g = group({ groupId: 'g', candidates: [
      candidate({ itemId: 'c', attemptIndex: 2 }),
      candidate({ itemId: 'a', attemptIndex: 0, state: 'failed', failureReason: 'boom' }),
      candidate({ itemId: 'b', attemptIndex: 1 }),
    ] });
    expect(heldCandidates(g).map((c) => c.itemId)).toEqual(['b', 'c']);
  });

  test('workItemFromNode narrows raw.item', () => {
    expect(workItemFromNode(worktreeNode('it-a', '/wt/it-a'))?.worktreePath).toBe('/wt/it-a');
    expect(workItemFromNode(workstreamNode('ws-1'))).toBeNull();
  });
});

// ── STEP 3: pick ────────────────────────────────────────────────────────────

describe('pick act: preview -> confirm through fleet.attempts.pick, no id typed', () => {
  test('Enter on a flagged pick row opens the picker and shows the first held diff', async () => {
    const { gateway, log } = makeGateway({ groups: [group({ groupId: 'g-1' })] });
    const { surface, log: diff } = makeDiffSurface();
    const { acts } = makeActs(gateway, surface);
    expect(acts.handleTreeKey('enter', workstreamNode('ws-1'))).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(log.listAttempts).toEqual(['ws-1']);
    expect(acts.pickModeActive()).toBe(true);
    expect(diff.shown.at(-1)?.diff).toContain('new it-a');
  });

  test('navigation chooses the winner; confirm round-trips preview(false) then confirm(true)', async () => {
    const { gateway, log } = makeGateway({ groups: [group({ groupId: 'g-1' })] });
    const { surface, log: diff } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    await acts.beginPick(workstreamNode('ws-1'));
    // Move to the second held candidate (it-b) and confirm.
    expect(acts.handlePickInput('down')).toBe(true);
    expect(diff.shown.at(-1)?.diff).toContain('new it-b');
    expect(acts.handlePickInput('enter')).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    // The PREVIEW call fired (confirm:false) for the chosen winner, no confirm yet.
    expect(log.pick).toEqual([{ groupId: 'g-1', winnerItemId: 'it-b', confirm: false }]);
    expect(diff.confirms).toHaveLength(1);
    // The operator confirms in the DiffPanel overlay -> the confirm(true) call applies.
    await diff.confirms[0]!.onConfirm();
    expect(log.pick).toEqual([
      { groupId: 'g-1', winnerItemId: 'it-b', confirm: false },
      { groupId: 'g-1', winnerItemId: 'it-b', confirm: true },
    ]);
    expect(diff.closed).toBe(1);
    expect(acts.pickModeActive()).toBe(false);
    expect(notes.some((n) => n.includes('Winner picked') && n.includes('attempt 2'))).toBe(true);
  });

  test('cancelling the confirm merges nothing and leaves pick mode', async () => {
    const { gateway, log } = makeGateway({ groups: [group({ groupId: 'g-1' })] });
    const { surface, log: diff } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    await acts.beginPick(workstreamNode('ws-1'));
    acts.handlePickInput('enter');
    await Promise.resolve();
    diff.confirms[0]!.onCancel?.();
    expect(log.pick.filter((p) => p.confirm)).toHaveLength(0);
    expect(acts.pickModeActive()).toBe(false);
    expect(notes.some((n) => n.includes('cancelled'))).toBe(true);
  });

  test('a workstream with no ready group refuses honestly, no pick mode', async () => {
    const { gateway } = makeGateway({ groups: [group({ groupId: 'g-1', ready: false })] });
    const { surface } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    await acts.beginPick(workstreamNode('ws-1'));
    expect(acts.pickModeActive()).toBe(false);
    expect(notes.some((n) => n.includes('No ready best-of-N group'))).toBe(true);
  });
});

// ── STEP 4: conflict ──────────────────────────────────────────────────────

describe('conflict act: resolve -> stamped session -> jump', () => {
  test('Enter on a flagged conflict row resolves and arms the jump on the stamped session', async () => {
    const { gateway, log } = makeGateway();
    const { surface } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    expect(acts.handleTreeKey('enter', conflictNode('it-a', ['a.ts', 'b.ts']))).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(log.resolveConflict).toEqual(['it-a']);
    expect(log.armed).toEqual(['sess-it-a']); // the STAMPED id, routed to the shared jump affordance
    expect(notes.some((n) => n.includes('press j to jump'))).toBe(true);
  });

  test('a failed resolution renders the honest error and arms no jump', async () => {
    const { gateway, log } = makeGateway({ resolveThrows: new Error('worktree gone') });
    const { surface } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    await acts.resolveConflict(conflictNode('it-x', ['a.ts']));
    expect(log.armed).toEqual([]);
    expect(notes.some((n) => n.includes('Conflict resolution failed') && n.includes('worktree gone'))).toBe(true);
  });
});

// ── STEP 5: discard ──────────────────────────────────────────────────────

describe('discard act: worktrees.discard behind a confirm, honest receipt', () => {
  test('D on a worktree row confirms then discards and renders the receipt', async () => {
    const { gateway, log } = makeGateway();
    const { surface, log: diff } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    expect(acts.handleTreeKey('D', worktreeNode('it-a', '/wt/it-a'))).toBe(true);
    expect(diff.confirms).toHaveLength(1);
    expect(log.discardWorktree).toEqual([]); // nothing until confirmed
    await diff.confirms[0]!.onConfirm();
    expect(log.discardWorktree).toEqual(['/wt/it-a']);
    expect(notes.some((n) => n.includes('Worktree discarded') && n.includes('branch kept') && n.includes('preservation commit'))).toBe(true);
  });

  test('D on a non-worktree row falls through (returns false), no confirm armed', () => {
    const { gateway } = makeGateway();
    const { surface, log: diff } = makeDiffSurface();
    const { acts } = makeActs(gateway, surface);
    expect(acts.handleTreeKey('D', workstreamNode('ws-1'))).toBe(false);
    expect(diff.confirms).toHaveLength(0);
  });

  test('cancelling the discard leaves the worktree untouched', async () => {
    const { gateway, log } = makeGateway();
    const { surface, log: diff } = makeDiffSurface();
    const { acts, notes } = makeActs(gateway, surface);
    acts.handleTreeKey('D', worktreeNode('it-a', '/wt/it-a'));
    diff.confirms[0]!.onCancel?.();
    expect(log.discardWorktree).toEqual([]);
    expect(notes.some((n) => n.includes('Discard cancelled'))).toBe(true);
  });
});

// ── gateway-unavailable degrade ─────────────────────────────────────────────

describe('acts degrade honestly when no daemon gateway is reachable', () => {
  test('beginPick surfaces the unavailable reason and stays out of pick mode', async () => {
    const { surface } = makeDiffSurface();
    const notes: string[] = [];
    const acts = new FleetActs({
      resolveGateway: () => ({ available: false, reason: 'the daemon is disabled (daemon.enabled=false)' }),
      diffSurface: surface,
      notify: (m) => notes.push(m),
      markDirty: () => {},
      findNode: () => null,
    });
    await acts.beginPick(workstreamNode('ws-1'));
    expect(acts.pickModeActive()).toBe(false);
    expect(notes.some((n) => n.includes('daemon is disabled'))).toBe(true);
  });
});
