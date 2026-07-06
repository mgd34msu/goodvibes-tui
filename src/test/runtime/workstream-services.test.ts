// ---------------------------------------------------------------------------
// workstream-services.test.ts — phase/work-item orchestration engine
//
// Integration test against a REAL OrchestrationEngine (not a fake) on a
// scratch workspace: create -> approve -> launch drives the engine through
// its actual engineer -> review pipeline (fromChainSpec's canned two-phase
// shape) with a stub agent executor, mirroring the SDK's own
// orchestration-engine.test.ts harness (bus.emit + createEventEnvelope over
// a fake PhaseRunnerAgentManagerLike) via the public npm surface this TUI
// consumes (@/runtime/index.ts re-exports RuntimeEventBus/createEventEnvelope
// from @pellux/goodvibes-sdk/platform/runtime/state — see
// agents/wrfc-controller.test.ts for the same pattern already in this repo).
//
// Command-layer behavior (fake service, no live engine) is covered
// separately in test/input/workstream-runtime-command.test.ts; this file
// proves the TUI's OWN wiring (createWorkstreamServices) produces a working
// engine end to end, not just that the SDK engine works in isolation.
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { PhaseRunnerAgentManagerLike } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createWorkstreamServices } from '../../runtime/workstream-services.ts';

/**
 * Drains BOTH the microtask queue and at least one real event-loop turn.
 * Plain microtask flushing (a loop of `await Promise.resolve()`) is enough
 * for the SDK's own orchestration-engine.test.ts because its harness passes
 * `createWorktree` (a fully-synchronous-resolving fake). This module does
 * NOT expose a createWorktree override (by design — see this file's header
 * doc: production always gets the engine's real default, a genuine
 * AgentWorktree(projectRoot) using simple-git). Every phase-runner completion
 * unconditionally calls worktree.cleanup(), so even in this scratch,
 * non-git directory (where git-tooling calls fail fast and are swallowed),
 * that failure still round-trips through real subprocess I/O — a macrotask,
 * not a microtask. setImmediate + a short setTimeout let that I/O actually
 * complete before the next assertion.
 */
async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function flushEngine(): Promise<void> {
  await flushMicrotasks(20);
  await new Promise((resolve) => setImmediate(resolve));
  await flushMicrotasks(20);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await flushMicrotasks(20);
}

function engineerReportOutput(summary: string, filesModified: string[] = []): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary,
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [summary],
      filesCreated: [],
      filesModified,
      filesDeleted: [],
      decisions: [],
      issues: [],
      uncertainties: [],
    }),
    '```',
  ].join('\n');
}

function reviewerReportOutput(score: number, passed: boolean): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: passed ? 'looks good' : 'needs fixes',
      score,
      passed,
      dimensions: [],
      issues: [],
      constraintFindings: [],
    }),
    '```',
  ].join('\n');
}

/** Mirrors wrfc-config.ts's getWrfcCommitScope contract closely enough for fromChainSpec + phase-runner: commitScope 'off' so no commit/git repo is needed, empty gates so runWrfcGateChecks trivially passes. */
function makeConfigManager(): { get: (key: string) => unknown; getCategory: (category: string) => unknown } {
  const wrfcCategory = {
    scoreThreshold: 9.9,
    maxFixAttempts: 3,
    autoCommit: false,
    transportRetryLimit: 0,
    transportRetryDelayMs: 0,
    commitScope: 'off' as const,
    gates: [] as Array<{ name: string; command: string; enabled: boolean }>,
  };
  return {
    get: (key: string) => {
      if (key === 'wrfc.commitScope') return 'off';
      // Default the decomposition to the heuristic path for the plain engine
      // wiring tests so they never spawn a real planning agent; the dedicated
      // agent-path test below overrides this.
      if (key === 'planner.decomposition') return 'heuristic';
      return undefined;
    },
    getCategory: (category: string) => (category === 'wrfc' ? wrfcCategory : undefined),
  };
}

const PLANNER_DECOMPOSITION_JSON = JSON.stringify({
  items: [
    { title: 'First item', brief: 'do the first thing', ordinal: 1 },
    { title: 'Second item', brief: 'do the second thing', ordinal: 2, dependsOn: [1] },
  ],
});

function makeAgentManagerHarness(bus: RuntimeEventBus): {
  agentManager: PhaseRunnerAgentManagerLike;
  completeAgent: (agentId: string, output: string) => void;
  spawnedTemplates: string[];
} {
  const agentStore = new Map<string, AgentRecord>();
  const spawnedTemplates: string[] = [];
  let counter = 0;
  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${++counter}`;
      spawnedTemplates.push(input.template ?? 'engineer');
      const isPlanner = input.template === 'planner';
      const record: AgentRecord = {
        id,
        task: input.task,
        template: input.template ?? 'engineer',
        tools: [],
        // A planning agent auto-completes with a valid decomposition so the
        // AgentManager-backed runner resolves on its first poll (no real LLM).
        status: isPlanner ? 'completed' : 'running',
        startedAt: Date.now(),
        ...(isPlanner ? { completedAt: Date.now(), fullOutput: PLANNER_DECOMPOSITION_JSON } : {}),
        toolCallCount: 0,
        ...(isPlanner ? { usage: { inputTokens: 300, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 } } : {}),
        orchestrationDepth: 0,
        executionProtocol: 'direct',
        reviewMode: 'none',
        communicationLane: 'parent-only',
      };
      agentStore.set(id, record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    cancel: (id: string) => {
      const record = agentStore.get(id);
      if (!record) return false;
      record.status = 'cancelled';
      return true;
    },
    registerCancellationSignal: () => {},
    releaseCancellationSignal: () => {},
  };

  function completeAgent(agentId: string, output: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'completed';
    record.fullOutput = output;
    record.usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };
    bus.emit('agents', createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  return { agentManager, completeAgent, spawnedTemplates };
}

describe('createWorkstreamServices — real engine wiring', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function makeScratchProjectRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gv-workstream-services-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'demo.ts'), 'export const demo = true;\n');
    return dir;
  }

  test('create -> approve -> launch drives a real OrchestrationEngine through engineer -> review to "passed"', async () => {
    const projectRoot = makeScratchProjectRoot();
    const bus = new RuntimeEventBus();
    const { agentManager, completeAgent } = makeAgentManagerHarness(bus);
    const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
      agentManager,
      configManager: makeConfigManager(),
      adaptivePlanner: new AdaptivePlanner(),
      runtimeBus: bus,
      projectRoot,
    });

    // create — the rendered proposal IS the real launchable spec (see
    // workstream-services.ts's buildSpec doc): the canned fromChainSpec
    // engineer -> review pipeline, not a fictional decomposition.
    const draft = await workstreamCommands.proposeDraft('ship the demo feature');
    expect(draft.spec.phases.map((p) => p.role)).toEqual(['engineer', 'reviewer']);
    expect(draft.provenance.kind).toBe('heuristic-configured');
    expect(draft.approved).toBe(false);

    // approve — flips the draft's own boolean; nothing exists in the engine yet.
    const approved = workstreamCommands.approveDraft(draft.id);
    expect(approved?.approved).toBe(true);
    expect(orchestrationEngine.listWorkstreams()).toHaveLength(0);

    // launch — NOW engine.createWorkstream + start actually run.
    const result = workstreamCommands.launchDraft(draft.id);
    expect(result).not.toBeNull();
    expect(workstreamCommands.getDraft(draft.id)).toBeUndefined(); // dropped once launched
    await flushEngine();

    const ws = orchestrationEngine.getWorkstream(result!.workstreamId)!;
    expect(ws).not.toBeNull();
    expect(ws.items).toHaveLength(1);
    const item = ws.items[0]!;
    expect(item.state).toBe('in-phase');
    expect(item.currentPhaseId).toBe(ws.phases[0]!.id); // engineer phase
    expect(item.agentId).toBeDefined();

    completeAgent(item.agentId!, engineerReportOutput('implemented the demo feature', ['src/demo.ts']));
    await flushEngine();
    expect(item.state).toBe('in-phase');
    expect(item.currentPhaseId).toBe(ws.phases[1]!.id); // advanced to review phase

    completeAgent(item.agentId!, reviewerReportOutput(10, true));
    await flushEngine();
    expect(item.state).toBe('passed');

    orchestrationEngine.dispose();
  });

  test('resumeAllFromDisk runs at construction and never throws against an empty .goodvibes/orchestration directory', () => {
    const projectRoot = makeScratchProjectRoot();
    const bus = new RuntimeEventBus();
    const { agentManager } = makeAgentManagerHarness(bus);
    let engine: ReturnType<typeof createWorkstreamServices>['orchestrationEngine'] | undefined;
    expect(() => {
      const services = createWorkstreamServices({
        agentManager,
        configManager: makeConfigManager(),
        adaptivePlanner: new AdaptivePlanner(),
        runtimeBus: bus,
        projectRoot,
      });
      engine = services.orchestrationEngine;
    }).not.toThrow();
    expect(engine!.listWorkstreams()).toHaveLength(0);
    engine!.dispose();
  });

  test('a rejected draft (edit without re-approval) cannot be launched', async () => {
    const projectRoot = makeScratchProjectRoot();
    const bus = new RuntimeEventBus();
    const { agentManager } = makeAgentManagerHarness(bus);
    const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
      agentManager,
      configManager: makeConfigManager(),
      adaptivePlanner: new AdaptivePlanner(),
      runtimeBus: bus,
      projectRoot,
    });

    const draft = await workstreamCommands.proposeDraft('original task');
    workstreamCommands.approveDraft(draft.id);
    await workstreamCommands.editDraft(draft.id, 'revised task');
    expect(workstreamCommands.getDraft(draft.id)!.approved).toBe(false);

    expect(workstreamCommands.launchDraft(draft.id)).toBeNull();
    expect(orchestrationEngine.listWorkstreams()).toHaveLength(0);
    orchestrationEngine.dispose();
  });

  test('agent decomposition: create spawns a planner agent (fleet pickup) and tags provenance', async () => {
    const projectRoot = makeScratchProjectRoot();
    const bus = new RuntimeEventBus();
    const { agentManager, spawnedTemplates } = makeAgentManagerHarness(bus);
    // Force the agent path (the default config manager above uses 'heuristic').
    const configManager = {
      get: (key: string) => (key === 'wrfc.commitScope' ? 'off' : key === 'planner.decomposition' ? 'agent' : undefined),
      getCategory: (category: string) => (category === 'wrfc'
        ? { scoreThreshold: 9.9, maxFixAttempts: 3, autoCommit: false, transportRetryLimit: 0, transportRetryDelayMs: 0, commitScope: 'off' as const, gates: [] }
        : undefined),
    };
    const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
      agentManager,
      configManager,
      adaptivePlanner: new AdaptivePlanner(),
      runtimeBus: bus,
      projectRoot,
    });

    const draft = await workstreamCommands.proposeDraft('build a multi-step feature');

    // The planning agent was spawned through the shared AgentManager (so it
    // appears in the fleet like any agent). It is a 'planner'-template agent.
    expect(spawnedTemplates).toContain('planner');
    // Its structured output validated → agent provenance with usage + item count.
    expect(draft.provenance.kind).toBe('agent');
    expect(draft.provenance.itemCount).toBe(2);
    expect(draft.provenance.agentTokens).toBe(420);

    // BIG-3: a genuine MULTI-item proposal maps to the REAL multi-item
    // workstream (fromPlanProposal), NOT a flattened single compat chain. The
    // phase template is still engineer→review, but there are now two items and
    // the inter-item dependency is preserved.
    expect(draft.spec.phases.map((p) => p.role)).toEqual(['engineer', 'reviewer']);
    expect(draft.spec.items).toHaveLength(2);
    expect(draft.spec.items.map((i) => i.title)).toEqual(['First item', 'Second item']);
    expect(draft.spec.items.map((i) => i.task)).toEqual(['do the first thing', 'do the second thing']);
    const first = draft.spec.items[0]!;
    const second = draft.spec.items[1]!;
    expect(second.dependsOn).toEqual([first.id!]); // "Second item" after "First item"
    expect(first.dependsOn ?? []).toEqual([]);
    // Workstream-level provenance carried through the mapping.
    expect(draft.spec.provenance?.decomposedBy).toBe('agent');

    orchestrationEngine.dispose();
  });

  test('launch of a multi-item draft passes a dependency-scheduled spec to createWorkstream (spy)', async () => {
    const projectRoot = makeScratchProjectRoot();
    const bus = new RuntimeEventBus();
    const { agentManager } = makeAgentManagerHarness(bus);
    const configManager = {
      get: (key: string) => (key === 'wrfc.commitScope' ? 'off' : key === 'planner.decomposition' ? 'agent' : undefined),
      getCategory: (category: string) => (category === 'wrfc'
        ? { scoreThreshold: 9.9, maxFixAttempts: 3, autoCommit: false, transportRetryLimit: 0, transportRetryDelayMs: 0, commitScope: 'off' as const, gates: [] }
        : undefined),
    };
    const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
      agentManager, configManager, adaptivePlanner: new AdaptivePlanner(), runtimeBus: bus, projectRoot,
    });

    // Spy on the exact input launch hands the engine.
    const created: Array<Parameters<typeof orchestrationEngine.createWorkstream>[0]> = [];
    const orig = orchestrationEngine.createWorkstream.bind(orchestrationEngine);
    orchestrationEngine.createWorkstream = (input) => { created.push(input); return orig(input); };

    const draft = await workstreamCommands.proposeDraft('build a multi-step feature');
    workstreamCommands.approveDraft(draft.id);
    const result = workstreamCommands.launchDraft(draft.id);
    expect(result).not.toBeNull();

    expect(created).toHaveLength(1);
    const input = created[0]!;
    expect(input.items).toHaveLength(2);
    expect(input.items[1]!.dependsOn).toEqual([input.items[0]!.id!]);
    expect(input.provenance?.decomposedBy).toBe('agent');

    // And the live engine reflects the dependency: the dependent starts blocked.
    await flushEngine();
    const ws = orchestrationEngine.getWorkstream(result!.workstreamId)!;
    const dependent = ws.items.find((i) => (i.dependsOn?.length ?? 0) > 0)!;
    expect(dependent.state).toBe('blocked-dependency');

    orchestrationEngine.dispose();
  });
});
