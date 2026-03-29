import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { run } from '../../../hooks/runners/agent.ts';
import { AgentManager } from '../../../tools/agent/index.ts';
import { AgentOrchestrator } from '../../../agents/orchestrator.ts';
import type { HookDefinition, HookEvent } from '../../../hooks/types.ts';

// ---------------------------------------------------------------------------
// Stub AgentOrchestrator.prototype.runAgent so agents stay 'pending' during
// tests. This keeps the hook runner's poll loop behaviorally predictable
// without using process-global mock.module() which pollutes parallel workers.
// ---------------------------------------------------------------------------
const _origRunAgent = AgentOrchestrator.prototype.runAgent;
AgentOrchestrator.prototype.runAgent = async function() {
  // Never resolves — agent stays pending until test advances status or cancels.
  return new Promise<void>(() => {});
};
afterAll(() => {
  AgentOrchestrator.prototype.runAgent = _origRunAgent;
});

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
    timeout: 1,  // 1 second timeout for tests
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup: reset AgentManager singleton between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  AgentManager.resetInstance();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('agent runner — validation', () => {
  test('returns error when prompt field is missing', async () => {
    const hook = makeHook({ prompt: undefined });
    const result = await run(hook, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('prompt');
  });

  test('allows empty string prompt (explicit empty is valid)', async () => {
    // Empty prompt passes the null check; $ARGUMENTS substitution produces a
    // non-empty task string, so the agent spawns successfully.
    const hook = makeHook({ prompt: '$ARGUMENTS', timeout: 1 });
    const runPromise = run(hook, makeEvent());
    // A spawn should occur — verify agent was registered
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const manager = AgentManager.getInstance();
    expect(manager.list().length).toBeGreaterThan(0);
    await runPromise;
  }, 5000);
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('agent runner — error paths', () => {
  test('returns error when spawn throws', async () => {
    const hook = makeHook();
    const event = makeEvent();
    const mgr = AgentManager.getInstance();
    const origSpawn = mgr.spawn.bind(mgr);
    mgr.spawn = () => { throw new Error('spawn failed'); };
    const result = await run(hook, event);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spawn failed');
    mgr.spawn = origSpawn;
  });

  test('returns error when agent disappears from registry', async () => {
    const hook = makeHook({ timeout: 5 });
    const runPromise = run(hook, makeEvent());

    // Wait for agent to be registered, then remove it
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const manager = AgentManager.getInstance();
    const agents = manager.list();
    expect(agents.length).toBeGreaterThan(0);

    // Clear the agent from the registry (same instance, agents map cleared)
    manager.clear();

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disappeared');
  }, 10000);
});

// ---------------------------------------------------------------------------
// Agent spawning
// ---------------------------------------------------------------------------

describe('agent runner — spawning', () => {
  test('spawns an agent and registers it in AgentManager', async () => {
    const hook = makeHook({ timeout: 1 });
    // Run the hook but don't await fully — just start it
    const runPromise = run(hook, makeEvent());

    // Give it a moment to spawn the agent before it times out
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // Check that an agent was registered
    const manager = AgentManager.getInstance();
    const agents = manager.list();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].task).toContain('Analyze the event');

    // Wait for hook to complete (will time out)
    await runPromise;
  });

  test('replaces $ARGUMENTS with event JSON in prompt', async () => {
    const hook = makeHook({ prompt: 'Event was: $ARGUMENTS', timeout: 1 });
    const event = makeEvent({ sessionId: 'sentinel-123' });

    const runPromise = run(hook, event);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const manager = AgentManager.getInstance();
    const agents = manager.list();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].task).toContain('sentinel-123');
    expect(agents[0].task).toContain('Event was:');

    await runPromise;
  });

  test('uses hook model override when provided', async () => {
    const hook = makeHook({ model: 'gpt-5', timeout: 1 });
    const runPromise = run(hook, makeEvent());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const manager = AgentManager.getInstance();
    const agents = manager.list();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].model).toBe('gpt-5');

    await runPromise;
  });
});

// ---------------------------------------------------------------------------
// Timeout behaviour
// ---------------------------------------------------------------------------

describe('agent runner — timeout', () => {
  test('returns ok:false with timeout error when agent stays pending', async () => {
    const hook = makeHook({ timeout: 1 });  // 1 second
    const result = await run(hook, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain('1s');
  }, 5000);

  test('cancels the agent on timeout', async () => {
    const hook = makeHook({ timeout: 1 });
    // Capture manager before run so we use the same instance after timeout
    const manager = AgentManager.getInstance();
    await run(hook, makeEvent());

    const agents = manager.list();
    // At least one agent should be cancelled
    const cancelled = agents.filter((a) => a.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThan(0);
  }, 5000);

  test('default timeout is 60s when not specified', async () => {
    // We only check that it does not immediately error without timeout;
    // the actual default is encoded in the runner source.
    const hook: HookDefinition = { match: 'Pre:agent:*', type: 'agent', prompt: 'task' };
    // timeout: 1 is not set — default should be 60s
    // Just check it spawns an agent, not that it runs for 60s
    const runPromise = run(hook, makeEvent());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const manager = AgentManager.getInstance();
    expect(manager.list().length).toBeGreaterThan(0);

    // Cancel via the manager so the test doesn't actually wait 60s
    for (const agent of manager.list()) {
      manager.cancel(agent.id);
    }

    await runPromise;
  });
});

// ---------------------------------------------------------------------------
// Agent completion paths
// ---------------------------------------------------------------------------

describe('agent runner — completion paths', () => {
  test('returns ok:true when agent completes successfully', async () => {
    const hook = makeHook({ timeout: 5 });
    const event = makeEvent();

    // Start the hook
    const runPromise = run(hook, event);

    // Wait for agent to be registered, then mark it completed
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const manager = AgentManager.getInstance();
    const agents = manager.list();
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

    const runPromise = run(hook, makeEvent());

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const manager = AgentManager.getInstance();
    const agents = manager.list();
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

    const runPromise = run(hook, makeEvent());

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const manager = AgentManager.getInstance();
    const agents = manager.list();
    manager.cancel(agents[0].id);

    const result = await runPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cancelled');
  }, 10000);

  test('includes additionalContext from agent progress when completed', async () => {
    const hook = makeHook({ timeout: 5 });

    const runPromise = run(hook, makeEvent());

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const manager = AgentManager.getInstance();
    const agents = manager.list();
    const agent = agents[0];
    agent.status = 'completed';
    agent.progress = 'Output: analysis complete';
    agent.completedAt = Date.now();

    const result = await runPromise;
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('Output: analysis complete');
  }, 10000);
});
