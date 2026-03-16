/**
 * Integration: Agent lifecycle — spawn → run → complete.
 *
 * Tests AgentManager and AgentMessageBus in an integrated fashion:
 * spawning agents, tracking status transitions, sending messages,
 * completing and cancelling agents.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { AgentManager, agentTool } from '../../tools/agent/index.ts';
import { AgentMessageBus } from '../../agents/message-bus.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetSingletons() {
  AgentManager.resetInstance();
  AgentMessageBus.resetInstance();
}

// ---------------------------------------------------------------------------
// Agent spawn lifecycle
// ---------------------------------------------------------------------------

describe('Agent lifecycle — spawn', () => {
  beforeEach(resetSingletons);

  test('spawning an agent returns a valid agentId', async () => {
    const result = await agentTool.execute({ mode: 'spawn', task: 'Build authentication module' });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect(typeof out.agentId).toBe('string');
    expect((out.agentId as string).startsWith('agent-')).toBe(true);
  });

  test('spawned agent has pending status immediately', async () => {
    const result = await agentTool.execute({ mode: 'spawn', task: 'Write unit tests' });
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect(out.status).toBe('spawned');
  });

  test('spawned agent is retrievable via status mode', async () => {
    const spawnResult = await agentTool.execute({ mode: 'spawn', task: 'Refactor database layer' });
    const spawnOut = JSON.parse(spawnResult.output!) as { agentId: string };
    const agentId = spawnOut.agentId;

    const statusResult = await agentTool.execute({ mode: 'status', agentId });
    expect(statusResult.success).toBe(true);
    const statusOut = JSON.parse(statusResult.output!) as Record<string, unknown>;
    expect(statusOut.id).toBe(agentId);
    expect(statusOut.task).toBe('Refactor database layer');
  });

  test('multiple agents can be spawned concurrently', async () => {
    const [r1, r2, r3] = await Promise.all([
      agentTool.execute({ mode: 'spawn', task: 'Task A' }),
      agentTool.execute({ mode: 'spawn', task: 'Task B' }),
      agentTool.execute({ mode: 'spawn', task: 'Task C' }),
    ]);
    const ids = [r1, r2, r3].map((r) => JSON.parse(r.output!).agentId as string);
    // All IDs are unique
    expect(new Set(ids).size).toBe(3);
  });

  test('agent IDs have 8 hex chars after agent- prefix', async () => {
    const result = await agentTool.execute({ mode: 'spawn', task: 'Test ID format' });
    const out = JSON.parse(result.output!) as { agentId: string };
    const suffix = out.agentId.slice('agent-'.length);
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  test('spawn with engineer template succeeds', async () => {
    const result = await agentTool.execute({
      mode: 'spawn',
      task: 'Implement OAuth flow',
      template: 'engineer',
    });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect(out.status).toBe('spawned');
  });

  test('spawn with invalid template returns error', async () => {
    const result = await agentTool.execute({
      mode: 'spawn',
      task: 'Some task',
      template: 'nonexistent-template-xyz',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent-template-xyz');
  });
});

// ---------------------------------------------------------------------------
// Agent list lifecycle
// ---------------------------------------------------------------------------

describe('Agent lifecycle — list', () => {
  beforeEach(resetSingletons);

  test('list starts empty', async () => {
    const result = await agentTool.execute({ mode: 'list' });
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect(out.count).toBe(0);
    expect(Array.isArray(out.agents)).toBe(true);
    expect((out.agents as unknown[]).length).toBe(0);
  });

  test('list includes spawned agents', async () => {
    await agentTool.execute({ mode: 'spawn', task: 'List test A' });
    await agentTool.execute({ mode: 'spawn', task: 'List test B' });

    const result = await agentTool.execute({ mode: 'list' });
    const out = JSON.parse(result.output!) as { count: number; agents: unknown[] };
    expect(out.count).toBe(2);
    expect(out.agents.length).toBe(2);
  });

  test('list entries include id and task fields', async () => {
    await agentTool.execute({ mode: 'spawn', task: 'Field check task' });
    const result = await agentTool.execute({ mode: 'list' });
    const out = JSON.parse(result.output!) as { agents: Array<{ id: string; task: string; status: string }> };
    const entry = out.agents[0]!;
    expect(typeof entry.id).toBe('string');
    expect(typeof entry.task).toBe('string');
    expect(typeof entry.status).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Agent cancellation
// ---------------------------------------------------------------------------

describe('Agent lifecycle — cancel', () => {
  beforeEach(resetSingletons);

  test('cancelling a spawned agent returns success', async () => {
    const spawn = await agentTool.execute({ mode: 'spawn', task: 'Cancel me' });
    const { agentId } = JSON.parse(spawn.output!) as { agentId: string };

    const cancel = await agentTool.execute({ mode: 'cancel', agentId });
    expect(cancel.success).toBe(true);
  });

  test('cancel response confirms the agent was cancelled', async () => {
    const spawn = await agentTool.execute({ mode: 'spawn', task: 'To be cancelled' });
    const { agentId } = JSON.parse(spawn.output!) as { agentId: string };

    // cancel() itself returns a success result with the agent record
    const cancel = await agentTool.execute({ mode: 'cancel', agentId });
    expect(cancel.success).toBe(true);
    const out = JSON.parse(cancel.output!) as Record<string, unknown>;
    // The cancel response contains the agentId
    expect(out.agentId).toBe(agentId);
  });

  test('cancelling unknown agent returns failure', async () => {
    const result = await agentTool.execute({ mode: 'cancel', agentId: 'agent-nonexistent' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentMessageBus integration
// ---------------------------------------------------------------------------

describe('Agent lifecycle — message bus', () => {
  beforeEach(resetSingletons);

  test('AgentMessageBus is a singleton', () => {
    const bus1 = AgentMessageBus.getInstance();
    const bus2 = AgentMessageBus.getInstance();
    expect(bus1).toBe(bus2);
  });

  test('can send a message to a spawned agent', async () => {
    const spawn = await agentTool.execute({ mode: 'spawn', task: 'Receive messages' });
    const { agentId } = JSON.parse(spawn.output!) as { agentId: string };

    const msg = await agentTool.execute({
      mode: 'message',
      agentId,
      message: 'Please prioritise authentication first.',
    });
    expect(msg.success).toBe(true);
    const out = JSON.parse(msg.output!) as { sent: boolean; agentId: string };
    expect(out.sent).toBe(true);
    expect(out.agentId).toBe(agentId);
  });

  test('message to unknown agent returns failure', async () => {
    const result = await agentTool.execute({
      mode: 'message',
      agentId: 'agent-unknown-xyz',
      message: 'hello',
    });
    expect(result.success).toBe(false);
  });
});
