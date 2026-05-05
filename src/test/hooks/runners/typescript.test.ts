import { describe, test, expect, beforeEach } from 'bun:test';
import { run } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookDefinition, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks';
import { resolve } from 'path';

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

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
const fixturesDir = resolve(import.meta.dir, 'fixtures');

beforeEach(() => {
  process.chdir(repoRoot);
});

describe('typescript runner', () => {
  describe('missing path field', () => {
    test('returns error when path not provided', async () => {
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts' };
      const result = await run(hook, makeEvent(), repoRoot);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('path');
    });
  });

  describe('dynamic import', () => {
    test('calls default export function with event', async () => {
      const filePath = resolve(fixturesDir, 'allow-hook.ts');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent(), repoRoot);
      if (!result.ok) throw new Error(`ts hook runner failed: ${result.error ?? 'unknown error'}`);
      expect(result.ok).toBe(true);
      expect(result.decision).toBe('allow');
    });

    test('passes event data correctly to handler', async () => {
      const filePath = resolve(fixturesDir, 'echo-hook.ts');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent({ sessionId: 'my-session' }), repoRoot);
      expect(result.additionalContext).toBe('session:my-session');
    });

    test('handler that returns deny passes through', async () => {
      const filePath = resolve(fixturesDir, 'deny-hook.ts');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent(), repoRoot);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('blocked by ts hook');
    });

    test('non-function default export returns error', async () => {
      const filePath = resolve(fixturesDir, 'not-fn-hook.ts');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent(), repoRoot);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('default function');
    });
  });

  describe('error handling', () => {
    test('handler that throws returns error gracefully', async () => {
      const filePath = resolve(fixturesDir, 'throw-hook.ts');
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent(), repoRoot);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('handler exploded');
    });

    test('nonexistent file returns error gracefully', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'ts',
        path: '/nonexistent/path/to/hook-xyz.ts',
      };
      const result = await run(hook, makeEvent(), repoRoot);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
