// ---------------------------------------------------------------------------
// workstream-attempts.test.ts — best-of-N surface: plan validation + the
// /workstream attempts list|diff|judge|pick subcommands.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type {
  AttemptJudgment,
  AttemptPickResult,
  CreateWorkstreamInput,
  HeldMergeGroup,
  OrchestrationEngine,
} from '@pellux/goodvibes-sdk/platform/orchestration';
import { AttemptError } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { CommandContext } from '../../input/command-registry.ts';
import type { WorkstreamCommandService } from '../../runtime/workstream-services.ts';
import { handleAttemptsSubcommand } from '../../input/commands/workstream-attempts.ts';
import { validateAttempts } from '../../runtime/workstream-attempts-validation.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';

// ---- validateAttempts ----------------------------------------------------

function spec(items: CreateWorkstreamInput['items'], isolation?: 'shared' | 'worktree'): CreateWorkstreamInput {
  return { title: 't', phases: [], items, isolation };
}

describe('validateAttempts — leaf + worktree constraints', () => {
  test('a worktree-isolated leaf best-of-N item is valid', () => {
    const v = validateAttempts(spec([{ id: 'a', title: 'A', task: 'a', attempts: 3 }], 'worktree'));
    expect(v.hasAttempts).toBe(true);
    expect(v.violations).toHaveLength(0);
  });

  test('best-of-N under shared isolation is a violation', () => {
    const v = validateAttempts(spec([{ id: 'a', title: 'A', task: 'a', attempts: 3 }], 'shared'));
    expect(v.violations.some((m) => /worktree-isolated/.test(m))).toBe(true);
  });

  test('a best-of-N item with dependencies breaks the leaf rule', () => {
    const v = validateAttempts(spec([
      { id: 'a', title: 'A', task: 'a' },
      { id: 'b', title: 'B', task: 'b', attempts: 2, dependsOn: ['a'] },
    ], 'worktree'));
    expect(v.violations.some((m) => /must be a leaf \(no dependencies/.test(m))).toBe(true);
  });

  test('a best-of-N item that others depend on breaks the leaf rule', () => {
    const v = validateAttempts(spec([
      { id: 'a', title: 'A', task: 'a', attempts: 2 },
      { id: 'b', title: 'B', task: 'b', dependsOn: ['a'] },
    ], 'worktree'));
    expect(v.violations.some((m) => /nothing may depend on it/.test(m))).toBe(true);
  });

  test('an over-cap attempts value is a non-blocking note', () => {
    const v = validateAttempts(spec([{ id: 'a', title: 'A', task: 'a', attempts: 9 }], 'worktree'));
    expect(v.violations).toHaveLength(0);
    expect(v.notes.some((m) => /caps best-of-N at 5/.test(m))).toBe(true);
  });
});

// ---- /workstream attempts subcommands ------------------------------------

function group(overrides: Partial<HeldMergeGroup> = {}): HeldMergeGroup {
  return {
    groupId: 'grp-000001',
    workstreamId: 'ws-1',
    sourceTitle: 'implement the parser',
    ready: true,
    autoAccept: false,
    judgment: null,
    candidates: [
      { itemId: 'item-a', attemptIndex: 0, state: 'held-merge', title: 'attempt A', worktreePath: '/wt/a', branch: 'b-a', usage: {} as never, failureReason: null, diff: { files: ['x.ts'], unifiedDiff: '@@ -1 +1 @@\n-old\n+A', stat: '1 file' } },
      { itemId: 'item-b', attemptIndex: 1, state: 'held-merge', title: 'attempt B', worktreePath: '/wt/b', branch: 'b-b', usage: {} as never, failureReason: null, diff: { files: ['x.ts'], unifiedDiff: '@@ -1 +1 @@\n-old\n+B', stat: '1 file' } },
    ],
    ...overrides,
  };
}

function makeEngine(over: Partial<{
  groups: HeldMergeGroup[];
  judgment: AttemptJudgment;
  judgeThrows: unknown;
  pick: AttemptPickResult;
  pickThrows: unknown;
}> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const engine = {
    listHeldMergeGroups: async () => { calls.push({ method: 'list', args: [] }); return over.groups ?? [group()]; },
    proposeAttemptWinner: async (gid: string) => { calls.push({ method: 'judge', args: [gid] }); if (over.judgeThrows) throw over.judgeThrows; return over.judgment ?? { proposedWinnerItemId: 'item-b', reasons: ['B is cleaner'], model: 'test-model', scoredBy: 'model' as const }; },
    pickAttemptWinner: async (gid: string, wid: string) => { calls.push({ method: 'pick', args: [gid, wid] }); if (over.pickThrows) throw over.pickThrows; return over.pick ?? { groupId: gid, winnerItemId: wid, loserItemIds: ['item-a'], auto: false }; },
  } as unknown as OrchestrationEngine;
  return { engine, calls };
}

function makeCtx() {
  const printed: string[] = [];
  let diffPanel: DiffPanel | null = null;
  const panelManager = {
    getAllOpen: () => (diffPanel ? [diffPanel] : []),
    open: (id: string) => { if (id === 'diff') { diffPanel = new DiffPanel('/tmp', () => {}); return diffPanel; } throw new Error('unknown'); },
    close: (id: string) => { if (id === 'diff') diffPanel = null; },
    activateById: () => {},
    isVisible: () => true,
    show: () => {},
  };
  const ctx = {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    focusPanels: () => {},
    focusPrompt: () => {},
    workspace: { panelManager },
    session: {}, provider: {}, platform: {}, ops: {}, extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, getDiffPanel: () => diffPanel };
}

const svc = (engine: OrchestrationEngine): WorkstreamCommandService => ({ engine } as unknown as WorkstreamCommandService);

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
}

describe('/workstream attempts', () => {
  test('returns false for a non-attempts subcommand', async () => {
    const { engine } = makeEngine();
    const { ctx } = makeCtx();
    expect(await handleAttemptsSubcommand(ctx, svc(engine), ['status'])).toBe(false);
  });

  test('list renders the held-merge groups and candidates', async () => {
    const { engine } = makeEngine();
    const { ctx, printed } = makeCtx();
    expect(await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'list'])).toBe(true);
    expect(printed.join('\n')).toContain('implement the parser');
    expect(printed.join('\n')).toContain('attempt A');
    expect(printed.join('\n')).toContain('READY');
  });

  test('judge shows the model proposal clearly labelled, with reasons', async () => {
    const { engine } = makeEngine();
    const { ctx, printed } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'judge', 'grp-000001']);
    const out = printed.join('\n');
    expect(out).toContain('MODEL PROPOSAL');
    expect(out).toContain('B is cleaner');
    expect(out).toContain('test-model');
  });

  test('judge with no configured judge reports it honestly (AttemptError)', async () => {
    const { engine } = makeEngine({ judgeThrows: new AttemptError('no judge configured') });
    const { ctx, printed } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'judge', 'grp-000001']);
    expect(printed.join('\n')).toContain('No judge available');
  });

  test('diff loads a candidate diff into the diff panel', async () => {
    const { engine } = makeEngine();
    const { ctx, printed, getDiffPanel } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'diff', 'grp-000001', '2']);
    expect(getDiffPanel()).not.toBeNull();
    expect(printed.join('\n')).toContain('attempt 2');
  });

  test('pick is confirm-gated, then picks the winner and renders the losers-cleaned receipt', async () => {
    const { engine, calls } = makeEngine();
    const { ctx, printed, getDiffPanel } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'pick', 'grp-000001', '2']);
    // Armed the confirm — no pick yet.
    expect(getDiffPanel()!.confirmOverlay.pending).toBe(true);
    expect(calls.some((c) => c.method === 'pick')).toBe(false);

    getDiffPanel()!.handleInput('y');
    await waitFor(() => calls.some((c) => c.method === 'pick'));
    const pickCall = calls.find((c) => c.method === 'pick')!;
    expect(pickCall.args).toEqual(['grp-000001', 'item-b']); // attempt #2 → item-b
    expect(printed.join('\n')).toContain('loser worktree(s) cleaned');
    expect(printed.join('\n')).toContain('merged through the integration lane');
  });

  test('pick on a not-ready group refuses', async () => {
    const { engine, calls } = makeEngine({ groups: [group({ ready: false })] });
    const { ctx, printed } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'pick', 'grp-000001', '1']);
    expect(printed.join('\n')).toContain('not ready');
    expect(calls.some((c) => c.method === 'pick')).toBe(false);
  });
});
