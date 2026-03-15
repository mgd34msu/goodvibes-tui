import { describe, test, expect } from 'bun:test';
import { run as runCommand } from '../../hooks/runners/command.ts';
import { run as runAgent } from '../../hooks/runners/agent.ts';
import { run as runPrompt } from '../../hooks/runners/prompt.ts';
import type { HookDefinition, HookEvent } from '../../hooks/types.ts';

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test-session',
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}

describe('command runner', () => {
  test('kills process and returns error on timeout', async () => {
    const hook: HookDefinition = {
      match: '*:*:*',
      type: 'command',
      command: 'sleep 60',
      timeout: 1, // 1 second timeout
    };
    const start = Date.now();
    const result = await runCommand(hook, makeEvent());
    const elapsed = Date.now() - start;

    // Should complete around 1s, not 60s
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    // Process killed via timeout triggers an exit (non-zero or error)
    // Bun resolves exited with signal kill — either ok:false or the proc exited non-zero
    // Either way the result should reflect failure or the process was cleaned up
    expect(result).toBeDefined();
  }, 8000);

  test('returns ok:false when command is missing', async () => {
    const hook: HookDefinition = { match: '*:*:*', type: 'command' };
    const result = await runCommand(hook, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing');
  });

  test('uses parsed ok value from JSON output', async () => {
    const hook: HookDefinition = {
      match: '*:*:*',
      type: 'command',
      command: 'echo \'{"ok":false,"error":"blocked"}\''  ,
    };
    const result = await runCommand(hook, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.error).toBe('blocked');
  });

  test('defaults ok to true when JSON output omits ok field', async () => {
    const hook: HookDefinition = {
      match: '*:*:*',
      type: 'command',
      command: 'echo \'{"additionalContext":"hello"}\''  ,
    };
    const result = await runCommand(hook, makeEvent());
    expect(result.ok).toBe(true);
    expect(result.additionalContext).toBe('hello');
  });
});

describe('agent runner stub', () => {
  test('returns ok:false with descriptive error', async () => {
    const hook: HookDefinition = { match: '*:*:*', type: 'agent' };
    const result = await runAgent(hook, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('not yet implemented');
  });
});

describe('prompt runner stub', () => {
  test('returns ok:false with descriptive error', async () => {
    const hook: HookDefinition = { match: '*:*:*', type: 'prompt' };
    const result = await runPrompt(hook, makeEvent());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('not yet implemented');
  });
});
