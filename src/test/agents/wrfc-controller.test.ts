import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { WrfcChain, WrfcChildRouteSelection } from '@pellux/goodvibes-sdk/platform/agents';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeEngineerOutput(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    archetype: 'engineer',
    summary: 'implemented requested changes',
    gatheredContext: ['src/test.ts'],
    plannedActions: ['update code'],
    appliedChanges: ['changed code'],
    filesCreated: [],
    filesModified: ['src/test.ts'],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
    ...overrides,
  });
}

function makeReviewerOutput(score: number, passed: boolean): string {
  return JSON.stringify({
    version: 1,
    archetype: 'reviewer',
    summary: score >= 9.9 ? 'review passed' : 'review failed',
    score,
    passed,
    dimensions: [],
    issues: passed
      ? []
      : [{ severity: 'major', description: 'Missing error handling', file: 'src/foo.ts', line: 10, pointValue: 1 }],
    // The review gate blocks deterministically when a reviewer emits no
    // acceptance checklist (on both review paths), so every fabricated review
    // must carry one, exactly like a real reviewer.
    acceptanceChecklist: [
      { item: 'the task contract is met', verified: passed, evidence: passed ? 'exercised the change end-to-end' : 'verification failed', howExercised: 'ran the suite' },
    ],
  });
}

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    id: `agent-${crypto.randomUUID().slice(0, 8)}`,
    task: 'test task',
    template: 'engineer',
    tools: ['read', 'write'],
    status: 'completed',
    startedAt: Date.now(),
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
    fullOutput: makeEngineerOutput(),
    ...overrides,
  };
}

function makeEnvelopeContext(agentId?: string): { sessionId: string; traceId: string; source: string; agentId?: string } {
  return {
    sessionId: 'test-session',
    traceId: `test-trace:${agentId ?? 'root'}`,
    source: 'wrfc-controller-test',
    ...(agentId ? { agentId } : {}),
  };
}

async function emitAgentCompleted(runtimeBus: RuntimeEventBus, agentId: string): Promise<void> {
  runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', {
    type: 'AGENT_COMPLETED',
    agentId,
    durationMs: 0,
    output: '',
    toolCallsMade: 0,
  }, makeEnvelopeContext(agentId)));
  await flushMicrotasks();
}

async function emitAgentFailed(runtimeBus: RuntimeEventBus, agentId: string, error: string): Promise<void> {
  runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
    type: 'AGENT_FAILED',
    agentId,
    error,
    durationMs: 0,
  }, makeEnvelopeContext(agentId)));
  await flushMicrotasks();
}

type SpawnInput = {
  task: string;
  template?: string;
  parentAgentId?: string;
  model?: string;
  provider?: string;
  fallbackModels?: string[];
  reasoningEffort?: AgentRecord['reasoningEffort'];
  dangerously_disable_wrfc?: boolean;
};

describe('WrfcController', () => {
  let runtimeBus: RuntimeEventBus;
  let emitSpy: ReturnType<typeof spyOn>;
  let projectRoot: string;
  let agentStore: Map<string, AgentRecord>;
  let spawnInputs: SpawnInput[];
  let spawnedRecords: AgentRecord[];
  let spawnCounter: number;
  let mockSpawn: ReturnType<typeof mock>;
  let mockGetStatus: ReturnType<typeof mock>;
  let mockCancel: ReturnType<typeof mock>;
  let mockRegisterAgent: ReturnType<typeof mock>;
  let mockMerge: ReturnType<typeof mock>;
  let mockCleanup: ReturnType<typeof mock>;
  let childRouteSelector: ((context: Parameters<NonNullable<ConstructorParameters<typeof WrfcController>[2]['selectChildRoute']>>[0]) => WrfcChildRouteSelection | null | undefined) | null;

  const mockConfigState: Record<string, unknown> = {
    'wrfc.scoreThreshold': 9.9,
    'wrfc.maxFixAttempts': 3,
    'wrfc.autoCommit': false,
  };
  const mockConfigGetCategoryState = {
    gates: [] as Array<{ name: string; command: string; enabled: boolean }>,
    scoreThreshold: 9.9,
    maxFixAttempts: 3,
    autoCommit: false,
  };
  const mockConfigManager = {
    get: (key: string) => mockConfigState[key],
    getCategory: (_category: string) => mockConfigGetCategoryState,
  };

  const workflowCalls = (type: string) => emitSpy.mock.calls.filter(
    (args: unknown[]) => args[0] === 'workflows' && typeof args[1] === 'object' && args[1] !== null
      && 'type' in (args[1] as object) && (args[1] as { type: string }).type === type,
  );
  const orchestrationCalls = (type: string) => emitSpy.mock.calls.filter(
    (args: unknown[]) => args[0] === 'orchestration' && typeof args[1] === 'object' && args[1] !== null
      && 'type' in (args[1] as object) && (args[1] as { type: string }).type === type,
  );

  function remember(record: AgentRecord): AgentRecord {
    agentStore.set(record.id, record);
    return record;
  }

  function initTestWrfcController(): WrfcController {
    return new WrfcController(runtimeBus, { registerAgent: mockRegisterAgent }, {
      agentManager: {
        spawn: mockSpawn,
        getStatus: mockGetStatus,
        list: () => Array.from(agentStore.values()),
        cancel: mockCancel,
        listByCohort: () => [],
        clear: () => {},
      },
      configManager: mockConfigManager as never,
      projectRoot,
      createWorktree: () => ({
        merge: mockMerge,
        cleanup: mockCleanup,
      }),
      ...(childRouteSelector ? { selectChildRoute: childRouteSelector } : {}),
    });
  }

  function createStartedChain(controller: WrfcController, ownerOverrides?: Partial<AgentRecord>): {
    owner: AgentRecord;
    chain: WrfcChain;
    engineer: AgentRecord;
  } {
    const owner = remember(makeRecord({
      id: 'agent-owner',
      task: 'implement the feature end to end',
      status: 'running',
      wrfcRole: undefined,
      ...ownerOverrides,
    }));
    const chain = controller.createChain(owner);
    const engineer = agentStore.get(chain.engineerAgentId ?? '');
    if (!engineer) {
      throw new Error('Expected createChain to spawn an engineer child');
    }
    return { owner, chain, engineer };
  }

  beforeEach(() => {
    runtimeBus = new RuntimeEventBus();
    emitSpy = spyOn(runtimeBus, 'emit');
    projectRoot = makeProjectTempDir('goodvibes-wrfc-test');
    // The SDK (>=0.33.38) runs verifyEngineerClaims, corroborating the engineer/fixer
    // report's claimed files against disk under projectRoot. Our engineer mock claims
    // filesModified: ['src/test.ts'], so materialize that file to make the claim
    // verifiable (kind='files_verified'); otherwise claimsVerified===false mechanically
    // blocks the pass (MIN-4) and chains land in 'fixing' instead of 'passed'.
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'test.ts'), 'export const placeholder = true;\n');
    agentStore = new Map();
    spawnInputs = [];
    spawnedRecords = [];
    spawnCounter = 0;
    childRouteSelector = null;

    mockConfigState['wrfc.scoreThreshold'] = 9.9;
    mockConfigState['wrfc.maxFixAttempts'] = 3;
    mockConfigState['wrfc.autoCommit'] = false;
    mockConfigGetCategoryState.gates = [];
    mockConfigGetCategoryState.scoreThreshold = 9.9;
    mockConfigGetCategoryState.maxFixAttempts = 3;
    mockConfigGetCategoryState.autoCommit = false;

    mockRegisterAgent = mock((_identity: unknown) => {});
    mockGetStatus = mock((id: string) => agentStore.get(id) ?? null);
    mockCancel = mock((id: string) => {
      const record = agentStore.get(id);
      if (!record) return false;
      record.status = 'cancelled';
      return true;
    });
    mockMerge = mock(async (_agentId: string) => true);
    mockCleanup = mock(async (_agentId: string) => {});
    mockSpawn = mock((input: SpawnInput) => {
      spawnInputs.push(input);
      const record = makeRecord({
        id: `agent-child-${spawnCounter++}`,
        task: input.task,
        template: input.template ?? 'general',
        status: 'pending',
        model: input.model,
        provider: input.provider,
        fallbackModels: input.fallbackModels,
        reasoningEffort: input.reasoningEffort,
        dangerously_disable_wrfc: input.dangerously_disable_wrfc,
        parentAgentId: input.parentAgentId,
        fullOutput: input.template === 'reviewer' ? makeReviewerOutput(10, true) : makeEngineerOutput(),
      });
      spawnedRecords.push(record);
      remember(record);
      return record;
    });
  });

  afterEach(() => {
    emitSpy?.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('owner-driven lifecycle', () => {
    test('createChain creates a durable owner and immediately spawns an engineer child', () => {
      const controller = initTestWrfcController();
      const { owner, chain, engineer } = createStartedChain(controller);

      expect(chain.id).toMatch(/^wrfc-[a-f0-9]{8}$/);
      expect(chain.state).toBe('engineering');
      expect(chain.ownerAgentId).toBe(owner.id);
      expect(owner.wrfcId).toBe(chain.id);
      expect(owner.wrfcRole).toBe('owner');
      expect(engineer.wrfcId).toBe(chain.id);
      expect(engineer.wrfcRole).toBe('engineer');
      expect(chain.allAgentIds).toEqual([owner.id, engineer.id]);
      expect(spawnInputs[0]).toMatchObject({
        template: 'engineer',
        task: owner.task,
        parentAgentId: owner.id,
        dangerously_disable_wrfc: true,
      });
    });

    test('createChain emits chain, graph, node, and owner decision records', () => {
      const controller = initTestWrfcController();
      const { chain } = createStartedChain(controller);

      expect(workflowCalls('WORKFLOW_CHAIN_CREATED')).toHaveLength(1);
      expect(orchestrationCalls('ORCHESTRATION_GRAPH_CREATED')).toHaveLength(1);
      expect(orchestrationCalls('ORCHESTRATION_NODE_STARTED').length).toBeGreaterThanOrEqual(1);
      expect(chain.ownerDecisions.map((decision) => decision.action)).toEqual(['chain_created', 'spawn_engineer']);
      expect(controller.getWorkmap().read(chain.id).some((event) => event.event === 'owner_decision')).toBe(true);
    });

    test('getChain/listChains expose owner-driven chain records', () => {
      const controller = initTestWrfcController();
      const { chain } = createStartedChain(controller);

      expect(controller.getChain(chain.id)).toBe(chain);
      expect(controller.listChains()).toEqual([chain]);
      expect(controller.getChain('wrfc-missing')).toBeNull();
    });

    test('resumeChain skips active child chains and records an owner decision', () => {
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      engineer.status = 'running';

      expect(controller.resumeChain(chain.id)).toBe(true);
      expect(chain.ownerDecisions.at(-1)?.action).toBe('resume_skipped');
      expect(chain.ownerDecisions.at(-1)?.reason).toContain('active child agent');
    });
  });

  describe('review and fix cycle', () => {
    test('engineer completion spawns a reviewer with the full-scope review prompt', async () => {
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      engineer.status = 'completed';
      engineer.fullOutput = makeEngineerOutput({ summary: 'engineer finished' });

      await emitAgentCompleted(runtimeBus, engineer.id);
      await new Promise((r) => setTimeout(r, 10));

      const reviewer = agentStore.get(chain.reviewerAgentId ?? '');
      expect(reviewer).toBeDefined();
      expect(reviewer?.wrfcRole).toBe('reviewer');
      expect(reviewer?.wrfcId).toBe(chain.id);
      expect(spawnInputs[1]).toMatchObject({ template: 'reviewer', dangerously_disable_wrfc: true });
      expect(spawnInputs[1].task).toContain('WRFC Review Request');
      expect(spawnInputs[1].task).toContain('Original WRFC ask');
      expect(spawnInputs[1].task).toContain('Engineer report digest');
      expect(chain.state).toBe('reviewing');
      expect(chain.ownerDecisions.at(-1)?.action).toBe('spawn_reviewer');
    });

    test('child route selector can set provider, model, fallback models, and reasoning effort', async () => {
      childRouteSelector = ({ role }) => role === 'reviewer'
        ? {
            provider: 'openai-subscriber',
            model: 'gpt-5.5',
            fallbackModels: ['openai:gpt-5.4'],
            reasoningEffort: 'high',
            reason: 'reviewers use high reasoning',
          }
        : null;
      const controller = initTestWrfcController();
      const { engineer, chain } = createStartedChain(controller, { provider: 'anthropic', model: 'claude-sonnet' });

      await emitAgentCompleted(runtimeBus, engineer.id);
      await new Promise((r) => setTimeout(r, 10));

      expect(spawnInputs[1]).toMatchObject({
        provider: 'openai-subscriber',
        model: 'gpt-5.5',
        fallbackModels: ['openai:gpt-5.4'],
        reasoningEffort: 'high',
      });
      expect(chain.ownerDecisions.at(-1)?.reason).toContain('reviewers use high reasoning');
      expect(chain.ownerDecisions.at(-1)).toMatchObject({
        action: 'spawn_reviewer',
        provider: 'openai-subscriber',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
      });
    });

    test('passing review runs gates and completes the owner when no gates are configured', async () => {
      const controller = initTestWrfcController();
      const { owner, chain, engineer } = createStartedChain(controller);
      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewer = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewer.fullOutput = makeReviewerOutput(10, true);

      await emitAgentCompleted(runtimeBus, reviewer.id);
      await new Promise((r) => setTimeout(r, 50));

      expect(chain.state).toBe('passed');
      expect(chain.gatesPassed).toBe(true);
      expect(chain.ownerTerminalEmitted).toBe(true);
      expect(owner.status).toBe('completed');
      expect(chain.ownerDecisions.map((decision) => decision.action)).toContain('review_passed');
      expect(chain.ownerDecisions.map((decision) => decision.action)).toContain('chain_passed');
      expect(workflowCalls('WORKFLOW_CHAIN_PASSED')).toHaveLength(1);
    });

    test('failing review starts a planned fix workstream and records owner decision', async () => {
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      // The single-fixer prompt was replaced by a planned fix WORKSTREAM (SDK
      // fix-phase rework): review findings decompose into a dependency-graph
      // workstream driven by a FixWorkstreamRunner. A pending runner keeps the
      // chain honestly 'fixing' while that cycle runs.
      controller.setFixWorkstreamRunner({ run: () => new Promise(() => {}) } as never);
      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewer = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewer.fullOutput = makeReviewerOutput(5, false);

      await emitAgentCompleted(runtimeBus, reviewer.id);
      await new Promise((r) => setTimeout(r, 10));

      expect(chain.state).toBe('fixing');
      expect(chain.fixAttempts).toBe(1);
      expect(workflowCalls('WORKFLOW_FIX_ATTEMPTED')).toHaveLength(1);
      expect(chain.ownerDecisions.at(-1)?.action).toBe('spawn_fixer');
    });

    test('a merged fix cycle re-reviews, and max fix attempts eventually fails the owner chain', async () => {
      mockConfigState['wrfc.maxFixAttempts'] = 1;
      mockConfigGetCategoryState.maxFixAttempts = 1;
      const controller = initTestWrfcController();
      // A 'merged' planned-fix runner resolves each cycle merged, the controller
      // proceeds to the terminal-contract re-review (a fresh reviewer spawn),
      // replacing the old complete-the-fixer-agent step.
      controller.setFixWorkstreamRunner({ run: async () => ({ status: 'merged', taskCount: 1, workstreamId: 'ws-fix-1', mergedTitles: ['fix task'], filesModified: ['src/test.ts'] }) } as never);
      const { owner, chain, engineer } = createStartedChain(controller);

      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewerOne = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewerOne.fullOutput = makeReviewerOutput(5, false);
      await emitAgentCompleted(runtimeBus, reviewerOne.id);
      // The merged fix cycle re-reviews the merged result against the original
      // contract (a fresh reviewer spawn). Complete that reviewer with another
      // fail; with maxFixAttempts already spent (1), the chain fails below threshold.
      await new Promise((r) => setTimeout(r, 20));
      const reviewerTwo = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewerTwo.fullOutput = makeReviewerOutput(5, false);
      await emitAgentCompleted(runtimeBus, reviewerTwo.id);
      await new Promise((r) => setTimeout(r, 20));

      expect(chain.fixAttempts).toBe(1);
      expect(chain.state).toBe('failed');
      expect(chain.error).toContain('below threshold');
      expect(owner.status).toBe('failed');
      expect(chain.ownerTerminalEmitted).toBe(true);
      expect(workflowCalls('WORKFLOW_CHAIN_FAILED')).toHaveLength(1);
      expect(chain.ownerDecisions.map((d) => d.action)).toContain('spawn_fixer');
    });
  });

  describe('gates and auto-commit', () => {
    test('enabled gate results are emitted before a passing chain completes', async () => {
      mockConfigGetCategoryState.gates = [
        { name: 'custom-pass-one', command: 'exit 0', enabled: true },
        { name: 'lint', command: 'exit 0', enabled: true },
      ];
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewer = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewer.fullOutput = makeReviewerOutput(10, true);

      await emitAgentCompleted(runtimeBus, reviewer.id);
      await new Promise((r) => setTimeout(r, 500));

      expect(chain.state).toBe('passed');
      expect(chain.gateResults?.map((result) => result.gate)).toEqual(['custom-pass-one', 'lint']);
      expect(workflowCalls('WORKFLOW_GATE_RESULT')).toHaveLength(2);
      expect(chain.ownerDecisions.map((decision) => decision.action)).toContain('gate_passed');
    });

    test('gate failure creates a same-chain gate fixer instead of spawning a new WRFC chain', async () => {
      mockConfigGetCategoryState.gates = [{ name: 'custom-fail', command: 'exit 1', enabled: true }];
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewer = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewer.fullOutput = makeReviewerOutput(10, true);

      await emitAgentCompleted(runtimeBus, reviewer.id);
      await new Promise((r) => setTimeout(r, 500));

      const fixer = agentStore.get(chain.fixerAgentId ?? '');
      expect(chain.state).toBe('fixing');
      expect(fixer?.wrfcRole).toBe('fixer');
      expect(spawnInputs.at(-1)?.task).toContain('WRFC Gate Failure Fix');
      expect(spawnInputs.at(-1)?.dangerously_disable_wrfc).toBe(true);
      expect(chain.ownerDecisions.at(-1)?.action).toBe('spawn_gate_fixer');
    });

    test('auto-commit merges the accepted writer and cleans every owner-chain agent on pass', async () => {
      mockConfigState['wrfc.autoCommit'] = true;
      mockConfigGetCategoryState.autoCommit = true;
      mkdirSync(join(projectRoot, '.git'));
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewer = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewer.fullOutput = makeReviewerOutput(10, true);

      await emitAgentCompleted(runtimeBus, reviewer.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(chain.state).toBe('passed');
      expect(mockMerge).toHaveBeenCalledTimes(1);
      expect(mockMerge).toHaveBeenCalledWith(engineer.id);
      expect(mockMerge).not.toHaveBeenCalledWith(reviewer.id);
      for (const id of chain.allAgentIds) {
        expect(mockCleanup.mock.calls.map((call) => call[0])).toContain(id);
      }
      expect(workflowCalls('WORKFLOW_AUTO_COMMITTED')).toHaveLength(1);
    });

    test('a merged fix cycle that then passes re-review lands the chain passed', async () => {
      mockConfigState['wrfc.autoCommit'] = true;
      mockConfigGetCategoryState.autoCommit = true;
      mkdirSync(join(projectRoot, '.git'));
      const controller = initTestWrfcController();
      // The single fixer was replaced by a planned fix workstream that does its
      // own reviewed-and-merged release; the controller re-reviews the merged
      // result and, on a pass, the chain lands passed.
      controller.setFixWorkstreamRunner({ run: async () => ({ status: 'merged', taskCount: 1, workstreamId: 'ws-fix-1', mergedTitles: ['fix task'], filesModified: ['src/test.ts'] }) } as never);
      const { chain, engineer } = createStartedChain(controller);

      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewerOne = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewerOne.fullOutput = makeReviewerOutput(5, false);
      await emitAgentCompleted(runtimeBus, reviewerOne.id);
      // The merged fix cycle re-reviews; that reviewer passes the original contract.
      await new Promise((r) => setTimeout(r, 20));
      const reviewerTwo = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewerTwo.fullOutput = makeReviewerOutput(10, true);
      await emitAgentCompleted(runtimeBus, reviewerTwo.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(chain.state).toBe('passed');
      expect(chain.fixAttempts).toBe(1);
      // The planned fix workstream did its own reviewed-and-merged release, so
      // the passing chain routes through the fix cycle (spawn_fixer), not a
      // separate single-fixer worktree auto-commit.
      expect(chain.ownerDecisions.map((d) => d.action)).toContain('spawn_fixer');
      expect(chain.ownerDecisions.map((d) => d.action)).toContain('review_passed');
    });

    test('auto-commit merge failure is a non-fatal warning; the reviewed chain still passes', async () => {
      // The full-scope review passed (10/10), so the chain SUCCEEDED. A commit/merge that could not
      // complete is a warning on a passing chain, never a flip to FAILED, the terminal status
      // derives from review + gates, not from the auto-commit result.
      mockConfigState['wrfc.autoCommit'] = true;
      mockConfigGetCategoryState.autoCommit = true;
      mkdirSync(join(projectRoot, '.git'));
      mockMerge.mockImplementation(async () => { throw new Error('merge conflict'); });
      const controller = initTestWrfcController();
      const { owner, chain, engineer } = createStartedChain(controller);
      await emitAgentCompleted(runtimeBus, engineer.id);
      const reviewer = agentStore.get(chain.reviewerAgentId ?? '')!;
      reviewer.fullOutput = makeReviewerOutput(10, true);

      await emitAgentCompleted(runtimeBus, reviewer.id);
      await new Promise((r) => setTimeout(r, 100));

      expect(chain.state).toBe('passed');
      expect(owner.status).toBe('completed');
      // Platform runtime 2.0.6: fullOutput carries the ANSWER (what the chain
      // actually produced); the review and (non-fatal) commit outcomes are
      // operator-audience status and live on progress.
      expect(owner.progress).toContain('review 10/10');
      expect(owner.progress).toContain('commit failed (non-fatal)');
      expect(owner.progress).toContain('merge conflict');
      expect(workflowCalls('WORKFLOW_CHAIN_FAILED')).toHaveLength(0);
      expect(workflowCalls('WORKFLOW_CHAIN_PASSED')).toHaveLength(1);
    });
  });

  describe('failure handling', () => {
    test('child failure fails the owner chain and cancels running children', async () => {
      const controller = initTestWrfcController();
      const { owner, chain, engineer } = createStartedChain(controller);
      engineer.status = 'running';

      await emitAgentFailed(runtimeBus, engineer.id, 'LLM call failed');

      expect(chain.state).toBe('failed');
      expect(chain.error).toContain('LLM call failed');
      expect(owner.status).toBe('failed');
      expect(chain.ownerDecisions.at(-1)?.action).toBe('chain_failed');
      expect(workflowCalls('WORKFLOW_CHAIN_FAILED')).toHaveLength(1);
    });

    test('owner completion before terminal chain state is ignored and recorded as owner decision', async () => {
      const controller = initTestWrfcController();
      const { owner, chain } = createStartedChain(controller);

      await emitAgentCompleted(runtimeBus, owner.id);

      expect(chain.state).toBe('engineering');
      expect(owner.status).toBe('running');
      expect(chain.error).toBeUndefined();
      expect(chain.ownerDecisions.at(-1)?.action).toBe('owner_completion_ignored');
      expect(chain.ownerDecisions.at(-1)?.reason).toContain('Ignored premature owner completion');
    });

    test('dispose stops event listener processing', async () => {
      const controller = initTestWrfcController();
      const { chain, engineer } = createStartedChain(controller);
      controller.dispose();

      await emitAgentCompleted(runtimeBus, engineer.id);
      await new Promise((r) => setTimeout(r, 20));

      expect(chain.state).toBe('engineering');
      expect(chain.reviewerAgentId).toBeUndefined();
    });
  });
});
