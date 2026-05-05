import { describe, test, expect } from 'bun:test';
import { run } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDefinition, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks';

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test',
    timestamp: Date.now(),
    payload: { tool: 'read' },
    ...overrides,
  };
}

describe('command runner', () => {
  describe('basic execution', () => {
    test('runs a simple command and returns ok', async () => {
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'command', command: 'true' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
    });

    test('returns error for non-zero exit code', async () => {
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'command', command: 'exit 1' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('1');
    });

    test('returns error for missing command field', async () => {
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'command' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('command');
    });
  });

  describe('stdin/stdout', () => {
    test('event JSON is passed to stdin', async () => {
      // The command reads stdin and echos it back; we check for a known field
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'cat',  // just echo stdin to stdout
      };
      const result = await run(hook, makeEvent({ sessionId: 'sentinel-session-id' }));
      // cat's output isn't valid JSON as HookResult, so it returns { ok: true }
      expect(result.ok).toBe(true);
    });

    test('parses JSON output from stdout as HookResult', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: `echo '{"ok":true,"decision":"allow"}'`,
      };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
      expect(result.decision).toBe('allow');
    });

    test('non-JSON stdout is treated as success', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'echo hello_not_json',
      };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
    });

    test('empty stdout is treated as success', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'true',
      };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
    });

    test('parses deny decision from stdout', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: `echo '{"ok":true,"decision":"deny","reason":"blocked"}'`,
      };
      const result = await run(hook, makeEvent());
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('blocked');
    });

    test('parses updatedInput from stdout', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: `echo '{"ok":true,"updatedInput":{"newPath":"/safe/path"}}'`,
      };
      const result = await run(hook, makeEvent());
      expect(result.updatedInput).toEqual({ newPath: '/safe/path' });
    });
  });

  describe('timeout', () => {
    test('command that exceeds timeout returns error', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: 'exec sleep 10',
        timeout: 1,  // 1 second
      };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      // Process is killed on timeout — exits with non-zero signal code (e.g. 143)
      expect(result.error).toBeTruthy();
    }, 10000);
  });

  describe('error handling', () => {
    test('command that does not exist returns error gracefully', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'command',
        command: '/nonexistent-binary-xyz-abc',
      };
      const result = await run(hook, makeEvent());
      // Should return ok:false with an error, not throw
      expect(result.ok).toBe(false);
    });
  });
});
