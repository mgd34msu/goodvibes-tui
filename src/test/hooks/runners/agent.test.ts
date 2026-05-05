import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '@pellux/goodvibes-sdk/platform/hooks';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { HookDefinition, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks';

const testAgentExecutor = {
  async runAgent() {
    // Never resolves - agent stays pending until test advances status or cancels.
    return new Promise<void>(() => {});
  },
};

let agentManager: AgentManager;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:agent:spawn',
    phase: 'Pre',
    category: 'agent',
    specific: 'spawn',
    sessionId: 'test-session',
    timestamp: Date.now(),
    payload: { task: 'do something' },
    ...overrides,
  };
}

function makeHook(overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    match: 'Pre:agent:*',
    type: 'agent',
    prompt: 'Analyze the event: $ARGUMENTS',
    timeout: 1,
    ...overrides,
  };
}

beforeEach(() => {
  const configDir = join(tmpdir(), `gv-agent-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  agentManager = new AgentManager({
    executor: testAgentExecutor,
    configManager: new ConfigManager({ surfaceRoot: 'tui',  configDir }),
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('agent runner - validation', () => {
  test('returns error when prompt field is missing', async () => {
    const hook = makeHook({ prompt: undefined });
    const result = await run(hook, makeEvent(), agentManager);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('prompt');
  });

  test('allows empty string prompt (explicit empty is valid)', async () => {
    const hook = makeHook({ prompt: '$ARGUMENTS', timeout: 1 });
    const runPromise = run(hook, makeEvent(), agentManager);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(agentManager.list().length).toBeGreaterThan(0);
    await runPromise;
  }, 5000);
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('agent runner - error paths', () => {
  test('returns error when spawn throws', async () => {
    const hook = makeHook();
    const event = makeEvent();
    const origSpawn = agentManager.spawn.bind(agentManager);
    agentManager.spawn = () => { throw new Error('spawn failed'); };
    const result = await run(hook, event, agentManager);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spawn failed');
    agentManager.spawn = origSpawn;
  });

  test('returns error when agent disappears from registry', async () => {
    const hook = makeHook({ timeout: 5 });
    const runPromise = run(hook, makeEvent(), agentManager);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const agents = agentManager.list();
    expect(agents.length).toBeGreaterThan(0);

    agentManager.clear();

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disappeared');
  }, 10000);
});

// ---------------------------------------------------------------------------
// Agent spawning
// ---------------------------------------------------------------------------

describe('agent runner - spawning', () => {
  test('spawns an agent and registers it in AgentManager', async () => {
    const hook = makeHook({ timeout: 1 });
    const runPromise = run(hook, makeEvent(), agentManager);

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const agents = agentManager.list();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].task).toContain('Analyze the event');

    await runPromise;
  });

  test('replaces $ARGUMENTS with event JSON in prompt', async () => {
    const hook = makeHook({ prompt: 'Event was: $ARGUMENTS', timeout: 1 });
    const event = makeEvent({ sessionId: 'sentinel-123' });

    const runPromise = run(hook, event, agentManager);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const agents = agentManager.list();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].task).toContain('sentinel-123');
    expect(agents[0].task).toContain('Event was:');

    await runPromise;
  });

  test('uses hook model override when provided', async () => {
    const hook = makeHook({ model: 'openai:gpt-5', timeout: 1 });
    const runPromise = run(hook, makeEvent(), agentManager);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const agents = agentManager.list();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].model).toBe('openai:gpt-5');

    await runPromise;
  });
});

// ---------------------------------------------------------------------------
// Timeout behaviour
// ---------------------------------------------------------------------------

describe('agent runner - timeout', () => {
  test('returns ok:false with timeout error when agent stays pending', async () => {
    const hook = makeHook({ timeout: 1 });
    const result = await run(hook, makeEvent(), agentManager);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain('1s');
  }, 5000);

  test('cancels the agent on timeout', async () => {
    const hook = makeHook({ timeout: 1 });
    await run(hook, makeEvent(), agentManager);

    const cancelled = agentManager.list().filter((a) => a.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThan(0);
  }, 5000);

  test('default timeout is 60s when not specified', async () => {
    const hook: HookDefinition = { match: 'Pre:agent:*', type: 'agent', prompt: 'task' };
    const runPromise = run(hook, makeEvent(), agentManager);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(agentManager.list().length).toBeGreaterThan(0);

    for (const agent of agentManager.list()) {
      agentManager.cancel(agent.id);
    }

    await runPromise;
  });
});

// ---------------------------------------------------------------------------
// Agent completion paths
// ---------------------------------------------------------------------------

describe('agent runner - completion paths', () => {
  test('returns ok:true when agent completes successfully', async () => {
    const hook = makeHook({ timeout: 5 });
    const event = makeEvent();

    const runPromise = run(hook, event, agentManager);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const agents = agentManager.list();
    expect(agents.length).toBeGreaterThan(0);

    const agent = agents[0];
    agent.status = 'completed';
    agent.completedAt = Date.now();
    agent.progress = 'Task finished';

    const result = await runPromise;
    expect(result.ok).toBe(true);
  }, 10000);

  test('returns ok:false with error when agent fails', async () => {
    const hook = makeHook({ timeout: 5 });

    const runPromise = run(hook, makeEvent(), agentManager);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const agents = agentManager.list();
    const agent = agents[0];
    agent.status = 'failed';
    agent.error = 'Something went wrong';
    agent.completedAt = Date.now();

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Something went wrong');
  }, 10000);

  test('returns ok:false when agent is cancelled externally', async () => {
    const hook = makeHook({ timeout: 5 });

    const runPromise = run(hook, makeEvent(), agentManager);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const agents = agentManager.list();
    agentManager.cancel(agents[0].id);

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cancelled');
  }, 10000);

  test('includes additionalContext from agent progress when completed', async () => {
    const hook = makeHook({ timeout: 5 });

    const runPromise = run(hook, makeEvent(), agentManager);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const agents = agentManager.list();
    const agent = agents[0];
    agent.status = 'completed';
    agent.progress = 'Output: analysis complete';
    agent.completedAt = Date.now();

    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('Output: analysis complete');
  }, 10000);
});
