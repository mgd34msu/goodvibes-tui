import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { createAgentTool, AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { OrchestrationEvent } from '@/runtime/index.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentHarness() {
  const configDir = join(tmpdir(), `gv-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir });
  const manager = new AgentManager({
    messageBus: new AgentMessageBus(),
    configManager,
  });
  const messageBus = new AgentMessageBus();
  const agentTool = createAgentTool({
    manager,
    messageBus,
    configManager,
  });
  return { agentTool, manager, messageBus, configManager };
}

let harness = makeAgentHarness();

async function runAgent(args: Record<string, unknown>) {
  const result = await harness.agentTool.execute(args);
  if (!result.success) throw new Error(result.error ?? 'agent tool failed');
  return JSON.parse(result.output!) as Record<string, unknown>;
}

async function runAgentMayFail(args: Record<string, unknown>) {
  return harness.agentTool.execute(args);
}

// ---------------------------------------------------------------------------
// Setup: reset shared test helper state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  harness = makeAgentHarness();
  harness.configManager.set('orchestration.maxActiveAgents', 8);
  harness.configManager.set('orchestration.maxDepth', 1);
  harness.configManager.set('orchestration.recursionEnabled', true);
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('spawn mode', () => {
  test('cohort spawn emits orchestration graph events on the runtime bus', async () => {
    const bus = new RuntimeEventBus();
    const manager = harness.manager;
    manager.setRuntimeBus(bus);
    const seen: string[] = [];

    const unsub = bus.onDomain('orchestration', (event) => {
      seen.push(event.type);
    });

    manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      cohort: 'alpha',
      template: 'engineer',
      tools: [],
    });

    await flushMicrotasks();
    unsub();
    expect(seen).toContain('ORCHESTRATION_GRAPH_CREATED');
    expect(seen).toContain('ORCHESTRATION_NODE_ADDED');
    expect(seen).toContain('ORCHESTRATION_NODE_STARTED');
  });

  test('spawn creates agent with correct ID format', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Implement user auth' });
    expect(typeof result.agentId).toBe('string');
    expect((result.agentId as string).startsWith('agent-')).toBe(true);
    // agent-XXXXXXXX (8 hex chars after prefix)
    const suffix = (result.agentId as string).slice('agent-'.length);
    expect(suffix.length).toBe(8);
  });

  test('spawn returns spawned status', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Write tests' });
    expect(result.status).toBe('spawned');
  });

  test('spawn returns task in result', async () => {
    const task = 'Refactor the database layer';
    const result = await runAgent({ mode: 'spawn', task });
    expect(result.task).toBe(task);
  });

  test('spawn with engineer template uses engineer defaults', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Build API', template: 'engineer' });
    expect(result.template).toBe('engineer');
    const tools = result.tools as string[];
    expect(tools).toContain('read');
    expect(tools).toContain('write');
    expect(tools).toContain('exec');
    expect(tools).toContain('analyze');
  });

  test('spawn with reviewer template uses reviewer defaults', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Review code', template: 'reviewer' });
    expect(result.template).toBe('reviewer');
    const tools = result.tools as string[];
    expect(tools).toContain('read');
    expect(tools).toContain('analyze');
    // reviewer does not include exec or write
    expect(tools).not.toContain('exec');
    expect(tools).not.toContain('write');
  });

  test('spawn without template defaults to general', async () => {
    const result = await runAgent({ mode: 'spawn', task: 'Do something' });
    expect(result.template).toBe('general');
  });

  test('spawn with explicit tools merges with template defaults (additive)', async () => {
    const result = await runAgent({
      mode: 'spawn',
      task: 'Custom task',
      template: 'engineer',
      tools: ['read', 'find'],
    });
    // Additive merge: defaults + input tools, deduplicated.
    // ArchetypeLoader built-in for 'engineer': ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry']
    // input.tools ['read', 'find'] are already in defaults, so merged = defaults unchanged.
    const engineerDefaults = ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'];
    const expected = [...new Set([...engineerDefaults, 'read', 'find'])];
    expect(result.tools).toEqual(expected);
  });

  test('spawn with restrictTools=true uses only specified tools', async () => {
    const result = await runAgent({
      mode: 'spawn',
      task: 'Custom task',
      template: 'engineer',
      tools: ['read', 'find'],
      restrictTools: true,
    });
    // restrictTools bypasses additive merge — only the specified tools are used
    expect(result.tools).toEqual(['read', 'find']);
    // Template defaults must NOT be present
    const tools = result.tools as string[];
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('exec');
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('analyze');
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

    expect(statusA.tools).toEqual(['read', 'find']);
    expect((statusA.tools as string[])).not.toContain('write');

    expect(statusB.tools).toEqual(['read']);
    expect((statusB.tools as string[])).not.toContain('write');
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

  test('child spawn fails when parent capability ceiling would remove all tools', async () => {
    const parent = await runAgent({
      mode: 'spawn',
      task: 'Parent reviewer',
      template: 'reviewer',
      tools: ['read'],
      restrictTools: true,
    });

    const result = await runAgentMayFail({
      mode: 'spawn',
      task: 'Child exec attempt',
      template: 'general',
      tools: ['exec'],
      restrictTools: true,
      parentAgentId: parent.agentId as string,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('capability ceiling');
  });

  test('child spawn is blocked when recursive orchestration is disabled', async () => {
    const parent = await runAgent({
      mode: 'spawn',
      task: 'Parent engineer',
      template: 'engineer',
      tools: ['read', 'find'],
      restrictTools: true,
    });

    harness.configManager.set('orchestration.recursionEnabled', false);
    const result = await runAgentMayFail({
      mode: 'spawn',
      task: 'Blocked child',
      template: 'general',
      tools: ['read'],
      restrictTools: true,
      parentAgentId: parent.agentId as string,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('recursive orchestration is disabled');
  });

  test('grandchild spawn is blocked when depth exceeds policy and emits recursion guard evidence', async () => {
    const bus = new RuntimeEventBus();
    const manager = harness.manager;
    manager.setRuntimeBus(bus);
    const seen: string[] = [];

    const unsub = bus.on<Extract<OrchestrationEvent, { type: 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED' }>>('ORCHESTRATION_RECURSION_GUARD_TRIGGERED', ({ payload }) => {
      seen.push(`${payload.graphId}:${payload.reason}`);
    });

    const parent = manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      template: 'engineer',
      tools: ['read', 'find'],
      restrictTools: true,
      cohort: 'alpha',
    });
    const child = manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      template: 'engineer',
      tools: ['read'],
      restrictTools: true,
      parentAgentId: parent.id,
      parentNodeId: parent.orchestrationNodeId,
      orchestrationGraphId: parent.orchestrationGraphId,
      orchestrationNodeId: 'child-node',
    });

    expect(() => manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      template: 'engineer',
      tools: ['read'],
      restrictTools: true,
      parentAgentId: child.id,
      parentNodeId: child.orchestrationNodeId,
      orchestrationGraphId: child.orchestrationGraphId,
      orchestrationNodeId: 'grandchild-node',
    })).toThrow(/depth/i);

    await flushMicrotasks();
    unsub();
    expect(seen.some((entry) => entry.includes('cohort:alpha'))).toBe(true);
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

  test('cancel subtree cancels the root and all descendants', () => {
    const manager = harness.manager;
    harness.configManager.set('orchestration.maxDepth', 2);
    const parent = manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      template: 'engineer',
      tools: ['read'],
      restrictTools: true,
      cohort: 'alpha',
    });
    const child = manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      template: 'engineer',
      tools: ['read'],
      restrictTools: true,
      parentAgentId: parent.id,
      parentNodeId: parent.orchestrationNodeId,
      orchestrationGraphId: parent.orchestrationGraphId,
      orchestrationNodeId: 'child-node',
    });
    const grandchild = manager.spawn({
      mode: 'spawn',
      task: 'Stuck task',
      template: 'engineer',
      tools: ['read'],
      restrictTools: true,
      parentAgentId: child.id,
      parentNodeId: child.orchestrationNodeId,
      orchestrationGraphId: child.orchestrationGraphId,
      orchestrationNodeId: 'grandchild-node',
    });

    const cancelled = manager.cancelSubtree(parent.id);
    expect(cancelled).toEqual([parent.id, child.id, grandchild.id]);
    expect(manager.getStatus(parent.id)?.status).toBe('cancelled');
    expect(manager.getStatus(child.id)?.status).toBe('cancelled');
    expect(manager.getStatus(grandchild.id)?.status).toBe('cancelled');
  });

  test('cancel graph cancels all agents in the target graph only', () => {
    const manager = harness.manager;
    const alphaA = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'alpha' });
    const alphaB = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'alpha' });
    const beta = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'beta' });

    const cancelled = manager.cancelGraph('cohort:alpha');
    expect(cancelled.sort()).toEqual([alphaA.id, alphaB.id].sort());
    expect(manager.getStatus(alphaA.id)?.status).toBe('cancelled');
    expect(manager.getStatus(alphaB.id)?.status).toBe('cancelled');
    expect(manager.getStatus(beta.id)?.status).toBe('pending');
  });

  test('spawn without task returns error', async () => {
    const result = await runAgentMayFail({ mode: 'spawn' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('task');
  });

  test('spawn with empty task returns error', async () => {
    const result = await runAgentMayFail({ mode: 'spawn', task: '   ' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('task');
  });

  test('each spawn produces a unique ID', async () => {
    const r1 = await runAgent({ mode: 'spawn', task: 'Task A' });
    const r2 = await runAgent({ mode: 'spawn', task: 'Task B' });
    expect(r1.agentId).not.toBe(r2.agentId);
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('status mode', () => {
  test('status returns agent info by ID', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Check status' });
    const agentId = spawned.agentId as string;

    const status = await runAgent({ mode: 'status', agentId });
    expect(status.id).toBe(agentId);
    expect(status.task).toBe('Check status');
    // Agent is immediately handed to orchestrator, so status progresses past 'pending'
    expect(['pending', 'running', 'completed', 'failed', 'cancelled']).toContain(status.status as string);
    expect(typeof status.durationMs).toBe('number');
    expect(typeof status.toolCallCount).toBe('number');
  });

  test('status returns error for unknown agent ID', async () => {
    const result = await runAgentMayFail({ mode: 'status', agentId: 'agent-notexist' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-notexist');
  });

  test('status without agentId returns error', async () => {
    const result = await runAgentMayFail({ mode: 'status' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('cancel mode', () => {
  test('cancel marks agent as cancelled', async () => {
    // 'Stuck task' prevents the orchestrator from running, keeping the agent in pending state.
    const spawned = await runAgent({ mode: 'spawn', task: 'Stuck task' });
    const agentId = spawned.agentId as string;

    const cancelled = await runAgent({ mode: 'cancel', agentId });
    expect(cancelled.agentId).toBe(agentId);
    expect(cancelled.status).toBe('cancelled');

    // Verify status also shows cancelled
    const status = await runAgent({ mode: 'status', agentId });
    expect(status.status).toBe('cancelled');
  });

  test('cancel unknown agent ID returns error', async () => {
    const result = await runAgentMayFail({ mode: 'cancel', agentId: 'agent-unknown1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-unknown1');
  });

  test('cancel without agentId returns error', async () => {
    const result = await runAgentMayFail({ mode: 'cancel' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });

  test('cancel on completed agent reports actual status (not forced cancelled)', async () => {
    // Spawn an agent, then manually advance its status to 'completed' via the manager.
    const spawned = await runAgent({ mode: 'spawn', task: 'Already done task' });
    const agentId = spawned.agentId as string;

    // Simulate completion by directly mutating the manager record.
    const manager = harness.manager;
    const record = manager.getStatus(agentId);
    if (record) {
      record.status = 'completed';
      record.completedAt = Date.now();
    }

    // Cancel should succeed (agent found) but report 'completed' since it was already done.
    const result = await runAgentMayFail({ mode: 'cancel', agentId });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!) as Record<string, unknown>;
    // AgentManager.cancel() only overwrites 'pending'/'running' — so status stays 'completed'.
    expect(parsed.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list mode', () => {
  test('list returns empty array when no agents exist', async () => {
    const result = await runAgent({ mode: 'list' });
    expect(result.agents).toEqual([]);
    expect(result.count).toBe(0);
  });

  test('list returns all spawned agents', async () => {
    await runAgent({ mode: 'spawn', task: 'Task One' });
    await runAgent({ mode: 'spawn', task: 'Task Two' });

    const result = await runAgent({ mode: 'list' });
    const agents = result.agents as Array<Record<string, unknown>>;
    expect(agents.length).toBe(2);
    expect(result.count).toBe(2);

    const tasks = agents.map((a) => a.task);
    expect(tasks).toContain('Task One');
    expect(tasks).toContain('Task Two');
  });

  test('list includes agent status fields', async () => {
    await runAgent({ mode: 'spawn', task: 'Task with fields' });

    const result = await runAgent({ mode: 'list' });
    const agents = result.agents as Array<Record<string, unknown>>;
    const agent = agents[0];
    expect(typeof agent.id).toBe('string');
    expect(typeof agent.task).toBe('string');
    expect(typeof agent.template).toBe('string');
    expect(typeof agent.status).toBe('string');
    expect(typeof agent.startedAt).toBe('number');
    expect(typeof agent.toolCallCount).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

describe('templates mode', () => {
  test('templates returns all 5 templates', async () => {
    const result = await runAgent({ mode: 'templates' });
    const templates = result.templates as Array<{ name: string }>;
    expect(templates.length).toBe(5);
  });

  test('templates includes engineer, reviewer, tester, researcher, general', async () => {
    const result = await runAgent({ mode: 'templates' });
    const templates = result.templates as Array<{ name: string }>;
    const names = templates.map((t) => t.name);
    expect(names).toContain('engineer');
    expect(names).toContain('reviewer');
    expect(names).toContain('tester');
    expect(names).toContain('researcher');
    expect(names).toContain('general');
  });

  test('each template has description and defaultTools', async () => {
    const result = await runAgent({ mode: 'templates' });
    const templates = result.templates as Array<{
      name: string;
      description: string;
      defaultTools: string[];
    }>;
    for (const t of templates) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(Array.isArray(t.defaultTools)).toBe(true);
      expect(t.defaultTools.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('get mode', () => {
  test('get returns detailed agent info', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Detailed task', template: 'engineer' });
    const agentId = spawned.agentId as string;

    const result = await runAgent({ mode: 'get', agentId });
    expect(result.id).toBe(agentId);
    expect(result.task).toBe('Detailed task');
    expect(result.template).toBe('engineer');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(typeof result.status).toBe('string');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.toolCallCount).toBe('number');
  });

  test('get includes recentMessages field', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Task with messages' });
    const agentId = spawned.agentId as string;

    const result = await runAgent({ mode: 'get', agentId });
    expect(Array.isArray(result.recentMessages)).toBe(true);
  });

  test('get includes messages sent to agent', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Task for messaging' });
    const agentId = spawned.agentId as string;

    // Send a message via the tool
    await runAgent({ mode: 'message', agentId, message: 'Hello agent!' });

    const result = await runAgent({ mode: 'get', agentId });
    const messages = result.recentMessages as Array<{ from: string; content: string; timestamp: number }>;
    expect(messages.some((m) => m.content === 'Hello agent!')).toBe(true);
  });

  test('get supports targeted detail views', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Targeted detail', template: 'engineer' });
    const agentId = spawned.agentId as string;
    await runAgent({ mode: 'message', agentId, message: 'Contract only' });

    const summary = await runAgent({ mode: 'get', agentId, detail: 'summary' });
    expect(summary.tools).toBeUndefined();
    expect(summary.recentMessages).toBeUndefined();

    const contract = await runAgent({ mode: 'get', agentId, detail: 'contract' });
    expect(Array.isArray(contract.tools)).toBe(true);
    expect(contract.recentMessages).toBeUndefined();

    const messages = await runAgent({ mode: 'get', agentId, detail: 'messages' });
    expect(messages.tools).toBeUndefined();
    expect(Array.isArray(messages.recentMessages)).toBe(true);
  });

  test('get returns error for unknown agent', async () => {
    const result = await runAgentMayFail({ mode: 'get', agentId: 'agent-unknown99' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-unknown99');
  });

  test('get requires agentId', async () => {
    const result = await runAgentMayFail({ mode: 'get' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

describe('budget mode', () => {
  test('budget returns token usage fields', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Budget task' });
    const agentId = spawned.agentId as string;

    const result = await runAgent({ mode: 'budget', agentId });
    expect(result.agentId).toBe(agentId);
    expect(typeof result.inputTokens).toBe('number');
    expect(typeof result.outputTokens).toBe('number');
    expect(typeof result.totalTokens).toBe('number');
    expect(typeof result.toolCallCount).toBe('number');
    expect(result.totalTokens).toBe((result.inputTokens as number) + (result.outputTokens as number));
  });

  test('budget returns error for unknown agent', async () => {
    const result = await runAgentMayFail({ mode: 'budget', agentId: 'agent-budgetfail' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-budgetfail');
  });

  test('budget requires agentId', async () => {
    const result = await runAgentMayFail({ mode: 'budget' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe('plan mode', () => {
  test('plan returns task, template, and tools', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Plan task', template: 'reviewer' });
    const agentId = spawned.agentId as string;

    const result = await runAgent({ mode: 'plan', agentId });
    expect(result.agentId).toBe(agentId);
    expect(result.task).toBe('Plan task');
    expect(result.template).toBe('reviewer');
    expect(Array.isArray(result.tools)).toBe(true);
    expect(typeof result.templateDescription).toBe('string');
  });

  test('plan returns model and provider as null when not set', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Plan without model' });
    const agentId = spawned.agentId as string;

    const result = await runAgent({ mode: 'plan', agentId });
    expect(result.model).toBeNull();
    expect(result.provider).toBeNull();
  });

  test('plan returns error for unknown agent', async () => {
    const result = await runAgentMayFail({ mode: 'plan', agentId: 'agent-planfail' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-planfail');
  });

  test('plan requires agentId', async () => {
    const result = await runAgentMayFail({ mode: 'plan' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });
});

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

describe('wait mode', () => {
  test('wait returns immediately when agent is already completed', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Already done' });
    const agentId = spawned.agentId as string;

    // Manually mark as completed
    const manager = harness.manager;
    const record = manager.getStatus(agentId);
    if (record) {
      record.status = 'completed';
      record.completedAt = Date.now();
    }

    const result = await runAgent({ mode: 'wait', agentId, timeoutMs: 5000 });
    expect(result.agentId).toBe(agentId);
    expect(result.status).toBe('completed');
    expect(result.timedOut).toBe(false);
  });

  test('wait times out when agent stays pending', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Stuck task' });
    const agentId = spawned.agentId as string;

    // Agent remains 'pending' — wait with very short timeout
    const result = await runAgent({ mode: 'wait', agentId, timeoutMs: 50 });
    expect(result.agentId).toBe(agentId);
    expect(result.timedOut).toBe(true);
  });

  test('wait returns immediately with hint when timeoutMs is 0 (default)', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Stuck task' });
    const agentId = spawned.agentId as string;

    // timeoutMs: 0 means no polling — should return immediately
    const result = await runAgent({ mode: 'wait', agentId, timeoutMs: 0 });
    expect(result.agentId).toBe(agentId);
    expect(result.timedOut).toBe(true);
    expect(result.hint).toContain('poll again');
  });

  test('wait returns immediately when agent is cancelled', async () => {
    // 'Stuck task' prevents the orchestrator from running, keeping the agent in pending state.
    const spawned = await runAgent({ mode: 'spawn', task: 'Stuck task' });
    const agentId = spawned.agentId as string;
    await runAgent({ mode: 'cancel', agentId });

    const result = await runAgent({ mode: 'wait', agentId, timeoutMs: 5000 });
    expect(result.status).toBe('cancelled');
    expect(result.timedOut).toBe(false);
  });

  test('wait returns error for unknown agent', async () => {
    const result = await runAgentMayFail({ mode: 'wait', agentId: 'agent-waitfail' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-waitfail');
  });

  test('wait requires agentId', async () => {
    const result = await runAgentMayFail({ mode: 'wait' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });

  test('wait returns deleted status when agent is removed during poll', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Stuck task' });
    const agentId = spawned.agentId as string;

    const manager = harness.manager;
    const originalRecord = manager.getStatus(agentId);

    // On first call return the record (initial existence check passes),
    // then return null for all subsequent calls (agent removed during poll).
    let callCount = 0;
    const spy = spyOn(manager, 'getStatus').mockImplementation((_id: string) => {
      callCount++;
      if (callCount === 1) return originalRecord;
      return null;
    });

    const result = await runAgent({ mode: 'wait', agentId, timeoutMs: 200 });

    spy.mockRestore();

    expect(result.agentId).toBe(agentId);
    expect(result.status).toBe('deleted');
  });
});

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

describe('message mode', () => {
  test('message sends to agent and returns sent=true', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Receive messages' });
    const agentId = spawned.agentId as string;

    const result = await runAgent({ mode: 'message', agentId, message: 'Hello from orchestrator' });
    expect(result.agentId).toBe(agentId);
    expect(result.sent).toBe(true);
    expect(result.content).toBe('Hello from orchestrator');
  });

  test('message is visible via getMessages on the bus', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Bus test' });
    const agentId = spawned.agentId as string;

    await runAgent({ mode: 'message', agentId, message: 'Check the bus' });

    const bus = harness.messageBus;
    const msgs = bus.getMessages(agentId);
    expect(msgs.some((m) => m.content === 'Check the bus')).toBe(true);
    expect(msgs.find((m) => m.content === 'Check the bus')?.from).toBe('orchestrator');
  });

  test('message returns error for unknown agent', async () => {
    const result = await runAgentMayFail({
      mode: 'message',
      agentId: 'agent-msgfail',
      message: 'Test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agent-msgfail');
  });

  test('message requires agentId', async () => {
    const result = await runAgentMayFail({ mode: 'message', message: 'No target' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });

  test('message requires message content', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Empty msg target' });
    const agentId = spawned.agentId as string;

    const result = await runAgentMayFail({ mode: 'message', agentId });
    expect(result.success).toBe(false);
    expect(result.error).toContain('message');
  });

  test('message with empty string returns error', async () => {
    const spawned = await runAgent({ mode: 'spawn', task: 'Whitespace message target' });
    const agentId = spawned.agentId as string;

    const result = await runAgentMayFail({ mode: 'message', agentId, message: '   ' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('message');
  });
});

// ---------------------------------------------------------------------------
// Error / validation cases
// ---------------------------------------------------------------------------

describe('error cases', () => {
  test('invalid mode returns error', async () => {
    const result = await runAgentMayFail({ mode: 'not_a_valid_mode' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('missing mode returns error', async () => {
    const result = await runAgentMayFail({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('mode');
  });

  test('spawn with invalid template returns error', async () => {
    const result = await runAgentMayFail({
      mode: 'spawn',
      task: 'Some task',
      template: 'nonexistent-template',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent-template');
  });
});
