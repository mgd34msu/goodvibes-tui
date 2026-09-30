// ---------------------------------------------------------------------------
// workstream-attempts.test.ts, best-of-N surface: the
// /workstream attempts list|diff|judge|pick subcommands.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type {
  AttemptJudgment,
  AttemptPickResult,
  HeldMergeGroup,
  OrchestrationEngine,
} from '@pellux/goodvibes-sdk/platform/orchestration';
import { AttemptError } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { CommandContext } from '../../input/command-registry.ts';
import type { WorkstreamCommandService } from '@pellux/goodvibes-sdk/platform/orchestration';
import { handleAttemptsSubcommand } from '../../input/commands/workstream-attempts.ts';

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
  const previews: Array<{ title: string; diff?: string; question?: { confirmLabel: string } }> = [];
  let pendingAnswer: ((ok: boolean) => void) | null = null;
  const ctx = {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    focusPrompt: () => {},
    previewChanges: (opts: { title: string; diff?: string; question?: { confirmLabel: string } }) => {
      previews.push(opts);
      if (!opts.question) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => { pendingAnswer = resolve; });
    },
    session: {}, provider: {}, platform: {}, ops: {}, extensions: {},
  } as unknown as CommandContext;
  const answer = (ok: boolean): void => { const r = pendingAnswer; pendingAnswer = null; r?.(ok); };
  return { ctx, printed, previews, answer, hasQuestion: () => pendingAnswer !== null };
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

  test('list shows dependents held by a non-leaf best-of-N group', async () => {
    const engine = {
      listHeldMergeGroups: async () => [group()],
      getWorkstream: (_id: string) => ({
        items: [
          { id: 'item-a', title: 'attempt A', state: 'held-merge', attemptSourceId: 'parser' },
          { id: 'item-b', title: 'attempt B', state: 'held-merge', attemptSourceId: 'parser' },
          { id: 'wire', title: 'Wire it up', state: 'blocked-dependency', dependsOn: ['parser'] },
        ],
      }),
    } as unknown as OrchestrationEngine;
    const { ctx, printed } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'list']);
    const out = printed.join('\n');
    expect(out).toContain('1 dependent(s) held until the winner is picked and merged');
    expect(out).toContain('"Wire it up"');
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

  test('diff shows a candidate diff in a Changes preview', async () => {
    const { engine } = makeEngine();
    const { ctx, printed, previews } = makeCtx();
    await handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'diff', 'grp-000001', '2']);
    expect(previews).toHaveLength(1);
    expect(previews[0]!.question).toBeUndefined();
    expect(printed.join('\n')).toContain('attempt 2');
  });

  test('pick is confirm-gated, then picks the winner and renders the losers-cleaned receipt', async () => {
    const { engine, calls } = makeEngine();
    const { ctx, printed, previews, answer, hasQuestion } = makeCtx();
    const running = handleAttemptsSubcommand(ctx, svc(engine), ['attempts', 'pick', 'grp-000001', '2']);
    // The question is up, no pick yet.
    await waitFor(hasQuestion);
    expect(previews[0]!.question?.confirmLabel).toBe('Pick');
    expect(calls.some((c) => c.method === 'pick')).toBe(false);

    answer(true);
    await running;
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
