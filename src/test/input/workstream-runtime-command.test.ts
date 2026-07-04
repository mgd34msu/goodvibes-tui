// ---------------------------------------------------------------------------
// workstream-runtime-command.test.ts — /workstream
//
// Pure command-layer test: a fake WorkstreamCommandService on ctx.session
// (no live OrchestrationEngine, no real agent spawning), following the
// project's existing command-test pattern (see checkpoint-runtime-command.test.ts).
// Exercises: the engine-absent guard, create rendering the real launchable
// spec (phases+items), approve/edit/launch driving the fake's state
// transitions, and list/status/insert-phase/cancel dispatch.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type {
  CreateWorkstreamInput,
  OrchestrationEngine,
  OrchestrationEventListener,
  Phase,
  PhaseResult,
  PhaseSpec,
  Workstream,
} from '@pellux/goodvibes-sdk/platform/orchestration';
import { CURRENT_WORKSTREAM_SCHEMA_VERSION } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { PlanProposal } from '@pellux/goodvibes-sdk/platform/core';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkstreamRuntimeCommands } from '../../input/commands/workstream-runtime.ts';
import type { WorkstreamCommandService, WorkstreamDraft, WorkstreamDraftProvenance } from '../../runtime/workstream-services.ts';

function makePhase(overrides: Partial<Phase> & { id: string; ordinal: number }): Phase {
  return {
    role: 'engineer',
    capacity: 1,
    kind: 'engineer',
    gate: { scope: 'scoped', gates: [] },
    ...overrides,
  };
}

function makeWorkstream(overrides: Partial<Workstream> & { id: string }): Workstream {
  return {
    title: overrides.id,
    schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    phases: [],
    items: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Minimal fake OrchestrationEngine — implements the full interface but only
 * getWorkstream/listWorkstreams/insertPhase/kill/createWorkstream/start carry
 * real behavior; the rest are honest no-ops the command module never calls. */
function makeFakeEngine(seed: Workstream[] = []): OrchestrationEngine & { createdInputs: CreateWorkstreamInput[]; startedIds: string[]; killedIds: string[] } {
  const workstreams = new Map(seed.map((ws) => [ws.id, ws]));
  const createdInputs: CreateWorkstreamInput[] = [];
  const startedIds: string[] = [];
  const killedIds: string[] = [];
  let counter = 0;
  return {
    createdInputs,
    startedIds,
    killedIds,
    createWorkstream(input: CreateWorkstreamInput): Workstream {
      createdInputs.push(input);
      const id = input.id ?? `ws-${++counter}`;
      const phases: Phase[] = input.phases.map((spec: PhaseSpec, i) => makePhase({ id: spec.id ?? `phase-${i}`, ordinal: i, role: spec.role, capacity: spec.capacity, kind: spec.kind, gate: spec.gate }));
      const items = input.items.map((spec) => ({
        id: spec.id ?? `item-${crypto.randomUUID().slice(0, 6)}`,
        title: spec.title,
        task: spec.task,
        currentPhaseId: phases[0]?.id ?? null,
        state: 'pending' as const,
        allAgentIds: [],
        visits: new Map<string, number>(),
        touchedPaths: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' as const },
        transportRetryCount: 0,
        createdAt: Date.now(),
      }));
      const ws = makeWorkstream({ id, title: input.title, phases, items });
      workstreams.set(id, ws);
      return ws;
    },
    getWorkstream: (id: string) => workstreams.get(id) ?? null,
    listWorkstreams: () => Array.from(workstreams.values()),
    insertPhase(workstreamId: string, afterOrdinal: number, spec: PhaseSpec): Phase | null {
      const ws = workstreams.get(workstreamId);
      if (!ws) return null;
      const phase = makePhase({ id: spec.id ?? `inserted-${crypto.randomUUID().slice(0, 6)}`, ordinal: afterOrdinal + 0.5, role: spec.role, capacity: spec.capacity, kind: spec.kind, gate: spec.gate });
      ws.phases = [...ws.phases, phase];
      return phase;
    },
    start: (id: string) => { startedIds.push(id); },
    // Mirrors the real engine's kill() guard (engine.ts): only 'passed' and
    // 'failed' are terminal — 'blocked-budget' (and every other non-terminal
    // state) is killable, same as 'pending'/'awaiting-capacity'/'in-phase'.
    kill: (itemId: string) => {
      killedIds.push(itemId);
      for (const ws of workstreams.values()) {
        const item = ws.items.find((it) => it.id === itemId);
        if (item && item.state !== 'passed' && item.state !== 'failed') {
          item.state = 'failed';
          return true;
        }
      }
      return false;
    },
    getPhaseResults: (): readonly PhaseResult[] => [],
    serializeWorkstream: () => null,
    importWorkstream: () => false,
    resumeWorkstream: () => false,
    resumeAllFromDisk: () => 0,
    on: (_listener: OrchestrationEventListener) => () => {},
    dispose: () => {},
  };
}

const AGENT_PROVENANCE: WorkstreamDraftProvenance = {
  kind: 'agent', itemCount: 3, agentCostUsd: 0.0123, agentTokens: 1000, elapsedMs: 42_000,
};

function fakeProposal(task: string): PlanProposal {
  return {
    id: 'pp-fake', task, strategy: 'cohort', rationale: 'fake', phases: [], workItems: [],
    createdAt: Date.now(), source: 'planner-agent',
  };
}

function makeFakeService(
  seed: Workstream[] = [],
  provenance: WorkstreamDraftProvenance = AGENT_PROVENANCE,
): WorkstreamCommandService & { engine: ReturnType<typeof makeFakeEngine> } {
  const engine = makeFakeEngine(seed);
  const drafts = new Map<string, WorkstreamDraft>();
  let counter = 0;
  return {
    engine,
    async proposeDraft(task: string): Promise<WorkstreamDraft> {
      const draft: WorkstreamDraft = {
        id: `wsd_${++counter}`,
        task,
        spec: {
          title: task,
          phases: [
            { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } },
            { role: 'reviewer', capacity: 1, kind: 'review', gate: { scope: 'scoped', gates: [] } },
          ],
          items: [{ id: 'seed-item', title: task, task }],
        },
        gate: { decompose: false, strategy: 'single', reasonCode: 'AUTO_FALLBACK_SINGLE' },
        proposal: fakeProposal(task),
        provenance,
        approved: false,
        createdAt: Date.now(),
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    getDraft: (id) => drafts.get(id),
    listDrafts: () => Array.from(drafts.values()),
    async editDraft(id, task) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.task = task;
      draft.spec = { ...draft.spec, title: task, items: [{ id: 'seed-item', title: task, task }] };
      draft.proposal = fakeProposal(task);
      draft.approved = false;
      return draft;
    },
    approveDraft(id) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.approved = true;
      return draft;
    },
    removeDraft: (id) => drafts.delete(id),
    launchDraft(id) {
      const draft = drafts.get(id);
      if (!draft || !draft.approved) return null;
      const ws = engine.createWorkstream(draft.spec);
      engine.start(ws.id);
      drafts.delete(id);
      return { workstreamId: ws.id };
    },
  };
}

function makeCtx(service?: WorkstreamCommandService) {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    session: {
      conversationManager: {},
      runtime: { model: 'm', provider: 'p', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
      workstreamEngine: service,
    },
    workspace: {},
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed };
}

// ---------------------------------------------------------------------------
// (a) command registration
// ---------------------------------------------------------------------------

describe('workstream-runtime command registration', () => {
  test('registers /workstream', () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    expect(registry.get('workstream')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (b) engine-absent guard
// ---------------------------------------------------------------------------

describe('workstream-runtime — engine-absent guard', () => {
  test('every subcommand prints the same honest guard when workstreamEngine is absent', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(undefined);
    await registry.execute('workstream', ['create', 'do', 'a', 'thing'], ctx);
    expect(printed).toEqual(['Workstreams are not available in this session.']);
  });
});

// ---------------------------------------------------------------------------
// (c) create — renders the REAL launchable spec (phases + items), not a
// fictional decomposition (see workstream-services.ts's buildSpec doc).
// ---------------------------------------------------------------------------

describe('workstream-runtime — create', () => {
  test('create renders the proposal id, phases, and work items to ctx.print', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('workstream', ['create', 'ship', 'the', 'thing'], ctx);

    expect(printed).toHaveLength(1);
    const output = printed[0]!;
    expect(output).toContain('ship the thing');
    expect(output).toContain('engineer');
    expect(output).toContain('reviewer');
    expect(output).toContain('Approve with');
  });

  test('create with no task text prints a usage error and proposes nothing', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('workstream', ['create'], ctx);

    expect(printed).toEqual(['Usage: /workstream create <task...>']);
    expect(service.listDrafts()).toHaveLength(0);
  });

  test('create carries an honest note that the proposal is not saved and is lost on restart', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('workstream', ['create', 'ship', 'the', 'thing'], ctx);

    expect(printed[0]).toContain('not saved');
    expect(printed[0]).toContain('restart');
  });

  test('provenance form: planning agent (item count, cost, elapsed)', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(makeFakeService([], {
      kind: 'agent', itemCount: 3, agentCostUsd: 0.0123, agentTokens: 1000, elapsedMs: 42_000,
    }));
    await registry.execute('workstream', ['create', 'ship', 'it'], ctx);
    expect(printed[0]).toContain('Decomposition: planning agent (3 items, $0.0123, 42s)');
  });

  test('provenance form: heuristic fallback with reason', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(makeFakeService([], {
      kind: 'fallback', itemCount: 1, fallbackReason: 'cancelled (wall-timeout 60000ms)',
    }));
    await registry.execute('workstream', ['create', 'ship', 'it'], ctx);
    expect(printed[0]).toContain('Decomposition: heuristic (agent fallback: cancelled (wall-timeout 60000ms))');
  });

  test('provenance form: heuristic configured', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(makeFakeService([], { kind: 'heuristic-configured', itemCount: 1 }));
    await registry.execute('workstream', ['create', 'ship', 'it'], ctx);
    expect(printed[0]).toContain('Decomposition: heuristic (configured)');
  });

  test('provenance form: token count when no priced cost is available', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(makeFakeService([], {
      kind: 'agent', itemCount: 2, agentTokens: 5000, elapsedMs: 3_000,
    }));
    await registry.execute('workstream', ['create', 'ship', 'it'], ctx);
    expect(printed[0]).toContain('Decomposition: planning agent (2 items, 5000 tok, 3s)');
  });
});

// ---------------------------------------------------------------------------
// (d) approve / edit / launch — drive the fake service's draft state
// ---------------------------------------------------------------------------

describe('workstream-runtime — approve / edit / launch', () => {
  test('launch without approval refuses honestly and never calls the engine', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);
    await registry.execute('workstream', ['create', 'task', 'one'], ctx);
    const draftId = service.listDrafts()[0]!.id;

    await registry.execute('workstream', ['launch', draftId], ctx);

    expect(printed.at(-1)).toContain('not approved yet');
    expect(service.engine.createdInputs).toHaveLength(0);
  });

  test('approve then launch calls engine.createWorkstream + start and drops the draft', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);
    await registry.execute('workstream', ['create', 'task', 'two'], ctx);
    const draftId = service.listDrafts()[0]!.id;

    await registry.execute('workstream', ['approve', draftId], ctx);
    expect(printed.at(-1)).toContain('Approved');

    await registry.execute('workstream', ['launch', draftId], ctx);
    expect(printed.at(-1)).toContain('Launched workstream');
    expect(service.engine.createdInputs).toHaveLength(1);
    expect(service.engine.startedIds).toHaveLength(1);
    expect(service.getDraft(draftId)).toBeUndefined();
  });

  test('edit re-derives the spec and clears a prior approval', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);
    await registry.execute('workstream', ['create', 'original', 'task'], ctx);
    const draftId = service.listDrafts()[0]!.id;
    await registry.execute('workstream', ['approve', draftId], ctx);
    expect(service.getDraft(draftId)!.approved).toBe(true);

    await registry.execute('workstream', ['edit', draftId, 'revised', 'task'], ctx);

    expect(service.getDraft(draftId)!.approved).toBe(false);
    expect(service.getDraft(draftId)!.task).toBe('revised task');
    expect(printed.at(-1)).toContain('revised task');
  });

  test('approve/edit/launch with an unknown id all refuse honestly', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('workstream', ['approve', 'does-not-exist'], ctx);
    await registry.execute('workstream', ['edit', 'does-not-exist', 'x'], ctx);
    await registry.execute('workstream', ['launch', 'does-not-exist'], ctx);

    expect(printed.every((line) => line.includes('No pending proposal found'))).toBe(true);
  });

  test('unknown id with zero drafts held mentions a restart as the likely cause', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('workstream', ['launch', 'does-not-exist'], ctx);

    expect(printed.at(-1)).toContain('No pending proposal found');
    expect(printed.at(-1)).toContain('restart');
  });

  test('unknown id with other drafts still held stays a plain not-found (no restart guess)', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);
    await registry.execute('workstream', ['create', 'a', 'real', 'draft'], ctx);

    await registry.execute('workstream', ['launch', 'does-not-exist'], ctx);

    expect(printed.at(-1)).toBe('No pending proposal found: does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// (e) list / status / insert-phase / cancel
// ---------------------------------------------------------------------------

describe('workstream-runtime — list / status / insert-phase / cancel', () => {
  test('list with nothing pending or running says so honestly', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(makeFakeService());
    await registry.execute('workstream', ['list'], ctx);
    expect(printed).toEqual(['No workstreams yet. Use /workstream create <task...> to propose one.']);
  });

  test('list shows pending proposals and live workstreams in separate sections', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const live = makeWorkstream({
      id: 'ws-live',
      title: 'live one',
      phases: [makePhase({ id: 'p1', ordinal: 0 })],
      items: [{ id: 'i1', title: 't', task: 't', currentPhaseId: 'p1', state: 'in-phase', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' }, transportRetryCount: 0, createdAt: Date.now() }],
    });
    const service = makeFakeService([live]);
    const { ctx, printed } = makeCtx(service);
    await registry.execute('workstream', ['create', 'a', 'pending', 'one'], ctx);

    await registry.execute('workstream', ['list'], ctx);

    const output = printed.at(-1)!;
    expect(output).toContain('Pending proposals');
    expect(output).toContain('Workstreams (1)');
    expect(output).toContain('live one');
  });

  test('status <id> renders phases and item states for a live workstream', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const live = makeWorkstream({
      id: 'ws-status',
      title: 'status target',
      phases: [makePhase({ id: 'p1', ordinal: 0, role: 'engineer' })],
      items: [{ id: 'item-1', title: 'do the work', task: 'do the work', currentPhaseId: 'p1', state: 'in-phase', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' }, transportRetryCount: 0, createdAt: Date.now() }],
    });
    const { ctx, printed } = makeCtx(makeFakeService([live]));

    await registry.execute('workstream', ['status', 'ws-status'], ctx);

    const output = printed.at(-1)!;
    expect(output).toContain('status target');
    expect(output).toContain('in-phase');
    expect(output).toContain('do the work');
  });

  test('status with an unknown id refuses honestly', async () => {
    const { ctx, printed } = makeCtx(makeFakeService());
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    await registry.execute('workstream', ['status', 'nope'], ctx);
    expect(printed.at(-1)).toContain('No workstream found');
  });

  test('insert-phase calls engine.insertPhase after the last existing ordinal', async () => {
    const live = makeWorkstream({
      id: 'ws-insert',
      title: 'insert target',
      phases: [makePhase({ id: 'p1', ordinal: 0 }), makePhase({ id: 'p2', ordinal: 1 })],
    });
    const service = makeFakeService([live]);
    const { ctx, printed } = makeCtx(service);
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);

    await registry.execute('workstream', ['insert-phase', 'ws-insert', 'security', 'audit'], ctx);

    expect(printed.at(-1)).toContain('Inserted phase "security audit"');
    const ws = service.engine.getWorkstream('ws-insert')!;
    expect(ws.phases).toHaveLength(3);
    expect(ws.phases.at(-1)!.role).toBe('security audit');
  });

  test('cancel on a pending proposal discards the draft without touching the engine', async () => {
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    await registry.execute('workstream', ['create', 'to', 'be', 'cancelled'], ctx);
    const draftId = service.listDrafts()[0]!.id;

    await registry.execute('workstream', ['cancel', draftId], ctx);

    expect(printed.at(-1)).toContain('Discarded pending proposal');
    expect(service.getDraft(draftId)).toBeUndefined();
    expect(service.engine.killedIds).toHaveLength(0);
  });

  test('cancel on a live workstream kills every in-flight work item via engine.kill', async () => {
    const live = makeWorkstream({
      id: 'ws-cancel',
      title: 'cancel target',
      phases: [makePhase({ id: 'p1', ordinal: 0 })],
      items: [
        { id: 'item-a', title: 'a', task: 'a', currentPhaseId: 'p1', state: 'in-phase', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' }, transportRetryCount: 0, createdAt: Date.now() },
        { id: 'item-b', title: 'b', task: 'b', currentPhaseId: null, state: 'passed', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' }, transportRetryCount: 0, createdAt: Date.now() },
      ],
    });
    const service = makeFakeService([live]);
    const { ctx, printed } = makeCtx(service);
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);

    await registry.execute('workstream', ['cancel', 'ws-cancel'], ctx);

    expect(service.engine.killedIds).toEqual(['item-a']); // 'passed' item-b is already terminal — never targeted
    expect(printed.at(-1)).toContain('Cancelled 1 of 1');
  });

  test('cancel reaches blocked-budget items too — not just pending/awaiting-capacity/in-phase', async () => {
    const live = makeWorkstream({
      id: 'ws-blocked',
      title: 'blocked target',
      phases: [makePhase({ id: 'p1', ordinal: 0 })],
      items: [
        { id: 'item-blocked', title: 'stuck on budget', task: 'stuck on budget', currentPhaseId: 'p1', state: 'blocked-budget', allAgentIds: [], visits: new Map(), touchedPaths: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' }, transportRetryCount: 0, createdAt: Date.now() },
      ],
    });
    const service = makeFakeService([live]);
    const { ctx, printed } = makeCtx(service);
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);

    await registry.execute('workstream', ['cancel', 'ws-blocked'], ctx);

    expect(service.engine.killedIds).toEqual(['item-blocked']);
    expect(printed.at(-1)).toContain('Cancelled 1 of 1');
    expect(printed.at(-1)).not.toContain('no in-flight work items');
  });

  test('status renders a custom insert-phase description honestly, not as a real role', async () => {
    const live = makeWorkstream({
      id: 'ws-custom',
      title: 'custom target',
      phases: [makePhase({ id: 'p1', ordinal: 0 })],
    });
    const service = makeFakeService([live]);
    const { ctx, printed } = makeCtx(service);
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    await registry.execute('workstream', ['insert-phase', 'ws-custom', 'security', 'audit'], ctx);

    await registry.execute('workstream', ['status', 'ws-custom'], ctx);

    const output = printed.at(-1)!;
    expect(output).toContain('custom: "security audit"');
    expect(output).toContain('engineer template');
    // Must not render the free text as if it were a real phase role like "custom — security audit".
    expect(output).not.toContain('custom — security audit');
  });
});
