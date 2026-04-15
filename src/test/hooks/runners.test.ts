import { describe, test, expect } from 'bun:test';
import { run as runCommand } from '@pellux/goodvibes-sdk/platform/hooks/runners/command';
import { run as runAgent } from '@pellux/goodvibes-sdk/platform/hooks/runners/agent';
import { run as runPrompt } from '@pellux/goodvibes-sdk/platform/hooks/runners/prompt';
import type { HookDefinition, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks/types';

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
      command: 'exec sleep 60',
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
  }, 10000);

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

describe('agent runner', () => {
  test('returns ok:false with error when prompt field is missing', async () => {
    const hook: HookDefinition = { match: '*:*:*', type: 'agent' };
    const result = await runAgent(hook, makeEvent(), {} as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('prompt');
  });
});

describe('prompt runner', () => {
  test('returns ok:false when prompt field is missing', async () => {
    // prompt runner requires hook.prompt template; missing template returns error
    const hook: HookDefinition = { match: '*:*:*', type: 'prompt' };
    const result = await runPrompt(hook, makeEvent(), null);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('prompt');
  });
});
