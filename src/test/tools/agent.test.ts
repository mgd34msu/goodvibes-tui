import { describe, test, expect, beforeEach } from 'bun:test';
import { agentTool } from '../../tools/agent/index.ts';
import { AgentManager } from '../../tools/agent/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runAgent(args: Record<string, unknown>) {
  const result = await agentTool.execute(args);
  if (!result.success) throw new Error(result.error ?? 'agent tool failed');
  return JSON.parse(result.output!) as Record<string, unknown>;
}

async function runAgentMayFail(args: Record<string, unknown>) {
  return agentTool.execute(args);
}

// ---------------------------------------------------------------------------
// Setup: reset singleton between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  AgentManager.resetInstance();
});

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('spawn mode', () => {
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

  test('spawn with explicit tools overrides template defaults', async () => {
    const result = await runAgent({
      mode: 'spawn',
      task: 'Custom task',
      template: 'engineer',
      tools: ['read', 'find'],
    });
    expect(result.tools).toEqual(['read', 'find']);
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
    expect(status.status).toBe('pending');
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
    const spawned = await runAgent({ mode: 'spawn', task: 'Long running task' });
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
});
