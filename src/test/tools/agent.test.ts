import { describe, test, expect, beforeEach } from 'bun:test';
import { createAgentTool, AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { AgentMessageBus, WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeWrfcAgentToolInvocation, wrapWrfcAgentTool } from '../../tools/wrfc-agent-guard.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentHarness() {
  const configDir = join(tmpdir(), `gv-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir });
  const runtimeBus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const manager = new AgentManager({
    messageBus,
    configManager,
  });
  manager.setRuntimeBus(runtimeBus);
  const wrfcController = new WrfcController(runtimeBus, messageBus, {
    agentManager: manager,
    configManager,
    projectRoot: configDir,
    fixWorkstreamRunner: { run: async () => ({ status: 'failed', reason: 'agent tool tests run no fix cycles', structured: 'tasks-failed' }) },
  });
  manager.setWrfcController(wrfcController);
  const agentTool = createAgentTool({
    manager,
    messageBus,
    configManager,
  });
  wrapWrfcAgentTool(agentTool);
  return { agentTool, manager, messageBus, configManager };
}

let harness = makeAgentHarness();

async function runAgent(args: Record<string, unknown>) {
  const result = await harness.agentTool.execute(args);
  if (!result.success) throw new Error(result.error ?? 'agent tool failed');
  return JSON.parse(result.output!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Setup: reset shared test helper state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  harness = makeAgentHarness();
  harness.configManager.set('fleet.maxSize', 8);
  harness.configManager.set('orchestration.maxDepth', 1);
  harness.configManager.set('orchestration.recursionEnabled', true);
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('spawn mode', () => {

  test('plain spawn does not implicitly start WRFC', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Inspect one thing with a normal agent' });
    const record = await runAgent({ mode: 'get', agentId: result.agentId as string });
    expect(record.reviewMode).toBe('none');
  });

  test('spawn with reviewer template normalizes into a WRFC owner chain', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Review code', template: 'reviewer' });
    expect(result.template).toBe('engineer');
    expect(result.reviewMode).toBe('wrfc');
    expect(result.task).toBe('Review code');
    expect(result.authoritativeWrfcChain).toBe(true);
    expect(result.continueRootSpawning).toBe(false);
    expect(result.orchestrationStopSignal).toBe('wrfc_owner_chain_started');
    expect(result.wrfcRole).toBe('owner');
    expect(result.wrfcRouteReason).toBe('root-review-role-normalized');
    expect(result.successCriteria).toContain('Keep the work as one WRFC owner chain; review, test, verification, and fix phases must remain lifecycle children.');
  });

  test('exact WRFC review root request from live repro normalizes into owner chain', async () => {
    const result = await runAgent({
      mode: 'spawn',
      task: 'WRFC review for a token bucket rate limiter',
      template: 'reviewer',
      reviewMode: 'wrfc',
      tools: ['read', 'find'],
      restrictTools: true,
    });

    expect(result.template).toBe('engineer');
    expect(result.reviewMode).toBe('wrfc');
    expect(result.task).toBe('WRFC review for a token bucket rate limiter');
    expect(result.authoritativeWrfcChain).toBe(true);
    expect(result.continueRootSpawning).toBe(false);
    expect(result.orchestrationStopSignal).toBe('wrfc_owner_chain_started');
    expect(result.wrfcRole).toBe('owner');
    expect(result.wrfcRouteReason).toBe('root-review-role-normalized');
    expect(result.successCriteria).toContain('Keep the work as one WRFC owner chain; review, test, verification, and fix phases must remain lifecycle children.');
    expect(harness.manager.list().filter((record) => record.parentAgentId == null)).toHaveLength(1);
  });

  test('batch-spawn with restrictTools propagates to each agent', async () => {
    const result = await runAgent({
      mode: 'batch-spawn',
      tasks: [
        { task: 'Batch task A', template: 'engineer', tools: ['read', 'find'], restrictTools: true },
        { task: 'Batch task B', template: 'engineer', tools: ['read'], restrictTools: true },
      ],
    });
    const agents = result.agents as Array<{ id: string; task: string }>;
    expect(agents.length).toBe(2);

    // Verify each spawned agent has only the restricted tools
    const statusA = await runAgent({ mode: 'get', agentId: agents[0].id });
    const statusB = await runAgent({ mode: 'get', agentId: agents[1].id });

    expect(statusA.reviewMode).toBe('none');
    expect(statusA.tools).toEqual(['read', 'find']);
    expect((statusA.tools as string[])).not.toContain('write');

    expect(statusB.reviewMode).toBe('none');
    expect(statusB.tools).toEqual(['read']);
    expect((statusB.tools as string[])).not.toContain('write');
  });

  test('collapses batch-spawn WRFC decomposition into one owner root chain', async () => {
    const result = await runAgent({
      mode: 'batch-spawn',
      cohort: 'bad-wrfc-fanout',
      reviewMode: 'wrfc',
      tasks: [
        {
          task: 'Implement the feature as WRFC owner.',
          template: 'engineer',
          tools: ['read', 'find'],
          restrictTools: true,
        },
        {
          task: 'Review the feature at the same time.',
          template: 'reviewer',
          tools: ['read', 'find'],
          restrictTools: true,
        },
      ],
    });
    const agents = result.agents as Array<{ id: string; task: string; template: string; cohort: string }>;

    expect(agents).toHaveLength(1);
    expect(agents[0]?.template).toBe('engineer');
    expect(agents[0]?.cohort).toBe('bad-wrfc-fanout');
    const record = await runAgent({ mode: 'get', agentId: agents[0]!.id });
    expect(record.reviewMode).toBe('wrfc');
    expect(record.wrfcRole).toBe('owner');
    expect(record.task).toBe('Implement the feature as WRFC owner.');
    expect(result.authoritativeWrfcChain).toBe(true);
    expect(result.continueRootSpawning).toBe(false);
    expect(result.orchestrationStopSignal).toBe('wrfc_owner_chain_started');
    expect(harness.manager.list().filter((agent) => agent.parentAgentId == null)).toHaveLength(1);
  });

  test('allows exactly one WRFC owner task to start one chain', async () => {
    const result = await runAgent({
      mode: 'batch-spawn',
      cohort: 'single-wrfc-owner',
      tasks: [
        {
          task: 'Implement the feature as the WRFC owner.',
          template: 'engineer',
          reviewMode: 'wrfc',
          tools: ['read', 'find'],
          restrictTools: true,
        },
      ],
    });
    const agents = result.agents as Array<{ id: string; template: string; cohort: string }>;

    expect(agents).toHaveLength(1);
    expect(agents[0]?.template).toBe('engineer');
    expect(agents[0]?.cohort).toBe('single-wrfc-owner');
  });

  test('normalizes explicit reviewer WRFC root owners instead of blocking', async () => {
    const result = await runAgent({
      mode: 'spawn',
      task: 'Review the feature through WRFC.',
      template: 'reviewer',
      reviewMode: 'wrfc',
      tools: ['read', 'find'],
      restrictTools: true,
    });

    expect(result.template).toBe('engineer');
    expect(result.reviewMode).toBe('wrfc');
    expect(result.task).toBe('Review the feature through WRFC.');
    expect(result.authoritativeWrfcChain).toBe(true);
    expect(result.continueRootSpawning).toBe(false);
    expect(result.orchestrationStopSignal).toBe('wrfc_owner_chain_started');
    expect(result.wrfcRole).toBe('owner');
    expect(result.wrfcRouteReason).toBe('root-review-role-normalized');
    expect(harness.manager.list().filter((agent) => agent.parentAgentId == null)).toHaveLength(1);
  });

  test('collapses narrowed rate limiter WRFC role batch to the authoritative user request', () => {
    const normalized = normalizeWrfcAgentToolInvocation({
      mode: 'batch-spawn',
      cohort: 'rate-limiter-wrfc',
      tasks: [
        {
          task: 'Independently design a minimal token bucket rate limiter API for an empty repository. Do not write files.',
          template: 'engineer',
          tools: ['find', 'inspect'],
          restrictTools: true,
          dangerously_disable_wrfc: true,
        },
        {
          task: 'Review expected correctness properties for the rate limiter. Do not write files.',
          template: 'reviewer',
          tools: ['find', 'inspect'],
          restrictTools: true,
          dangerously_disable_wrfc: true,
        },
      ],
    }, {
      getLastUserMessage: () => 'make a token bucket rate limiter',
    });

    expect(normalized.mode).toBe('spawn');
    expect(normalized.task).toBe('make a token bucket rate limiter');
    expect(normalized.template).toBe('engineer');
    expect(normalized.reviewMode).toBe('wrfc');
    expect(normalized.dangerously_disable_wrfc).toBe(false);
    expect(normalized.tools).toBeUndefined();
    expect(normalized.restrictTools).toBeUndefined();
    const context = String(normalized.context);
    expect(context).toContain('Authoritative user request');
    expect(context).toContain('Proposed child tasks');
    expect(context).toContain('Do not write files');
  });

  test('normalizes plain batch-spawn to disable WRFC on every root agent', () => {
    const normalized = normalizeWrfcAgentToolInvocation({
      mode: 'batch-spawn',
      cohort: 'plain-batch',
      tasks: [
        { task: 'Inspect package metadata', template: 'engineer' },
        { task: 'Inspect tests', template: 'engineer', reviewMode: 'none' },
      ],
    });

    expect(normalized.reviewMode).toBe('none');
    expect(normalized.dangerously_disable_wrfc).toBe(true);
    const tasks = normalized.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.reviewMode === 'none')).toBe(true);
    expect(tasks.every((task) => task.dangerously_disable_wrfc === true)).toBe(true);
  });

  test('child spawn inherits and enforces the parent capability ceiling', async () => {
    const parent = await runAgent({
      mode: 'spawn',
      task: 'Parent engineer',
      template: 'engineer',
      tools: ['read', 'find'],
      restrictTools: true,
    });

    const child = await runAgent({
      mode: 'spawn',
      task: 'Child researcher',
      template: 'general',
      tools: ['read', 'exec', 'find'],
      restrictTools: true,
      parentAgentId: parent.agentId as string,
      successCriteria: ['answer the question'],
      requiredEvidence: ['file list'],
      writeScope: ['src/runtime'],
      executionProtocol: 'gather-plan-apply',
      reviewMode: 'wrfc',
      communicationLane: 'parent-only',
    });

    expect(child.tools).toEqual(['read', 'find']);
    expect(child.capabilityCeilingTools).toEqual(['read', 'find']);
    expect(child.parentAgentId).toBe(parent.agentId);
    expect(child.successCriteria).toEqual(['answer the question']);
    expect(child.requiredEvidence).toEqual(['file list']);
    expect(child.writeScope).toEqual(['src/runtime']);
    expect(child.executionProtocol).toBe('gather-plan-apply');
    expect(child.reviewMode).toBe('wrfc');
    expect(child.communicationLane).toBe('parent-only');
  });

  test('cohort spawn emits orchestration node contracts on the runtime bus', async () => {
    const bus = new RuntimeEventBus();
    const manager = harness.manager;
    manager.setRuntimeBus(bus);
    const payloads: Array<Record<string, unknown>> = [];

    const unsub = bus.on('ORCHESTRATION_NODE_ADDED', ({ payload }) => {
      payloads.push(payload as unknown as Record<string, unknown>);
    });

    manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      cohort: 'alpha',
      template: 'engineer',
      tools: ['read', 'edit'],
      restrictTools: true,
      successCriteria: ['edit target file'],
      requiredEvidence: ['changed lines'],
      writeScope: ['src/core'],
      executionProtocol: 'gather-plan-apply',
      reviewMode: 'wrfc',
      communicationLane: 'parent-only',
    });

    await flushMicrotasks();
    unsub();
    const node = payloads[0];
    expect(node).toBeDefined();
    expect(node?.contract).toEqual({
      allowedTools: ['read', 'edit'],
      capabilityCeiling: ['read', 'edit'],
      successCriteria: ['edit target file'],
      requiredEvidence: ['changed lines'],
      writeScope: ['src/core'],
      executionProtocol: 'gather-plan-apply',
      reviewMode: 'wrfc',
      inheritsParentConstraints: false,
      communicationLane: 'parent-only',
    });
  });
});
