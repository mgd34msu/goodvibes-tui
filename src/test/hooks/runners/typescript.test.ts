import { describe, test, expect, afterEach } from 'bun:test';
import { run } from '../../../hooks/runners/typescript.ts';
import type { HookDefinition, HookEvent, HookResult } from '../../../hooks/types.ts';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    path: 'Pre:tool:read',
    phase: 'Pre',
    category: 'tool',
    specific: 'read',
    sessionId: 'test',
    timestamp: Date.now(),
    payload: { tool: 'file_read' },
    ...overrides,
  };
}

const tmpFiles: string[] = [];

function writeTempTs(name: string, content: string): string {
  const dir = join(process.cwd(), 'test-tmp-hooks');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  tmpFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try { unlinkSync(f); } catch {}
  }
  tmpFiles.length = 0;
});

describe('typescript runner', () => {
  describe('missing path field', () => {
    test('returns error when path not provided', async () => {
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts' };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('path');
    });
  });

  describe('dynamic import', () => {
    test('calls default export function with event', async () => {
      const filePath = writeTempTs('allow-hook.ts',
        `export default async function handler(event: unknown): Promise<{ ok: boolean; decision: string }> {
  return { ok: true, decision: 'allow' };
}`
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(true);
      expect(result.decision).toBe('allow');
    });

    test('passes event data correctly to handler', async () => {
      const filePath = writeTempTs('echo-hook.ts',
        `export default async function handler(event: any): Promise<{ ok: boolean; additionalContext: string }> {
  return { ok: true, additionalContext: 'session:' + event.sessionId };
}`
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent({ sessionId: 'my-session' }));
      expect(result.additionalContext).toBe('session:my-session');
    });

    test('handler that returns deny passes through', async () => {
      const filePath = writeTempTs('deny-hook.ts',
        `export default async function handler(event: any): Promise<{ ok: boolean; decision: string; reason: string }> {
  return { ok: true, decision: 'deny', reason: 'blocked by ts hook' };
}`
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent());
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('blocked by ts hook');
    });

    test('non-function default export returns error', async () => {
      const filePath = writeTempTs('not-fn-hook.ts',
        `export default { notAFunction: true };`
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('default function');
    });
  });

  describe('error handling', () => {
    test('handler that throws returns error gracefully', async () => {
      const filePath = writeTempTs('throw-hook.ts',
        `export default async function handler(): Promise<never> {
  throw new Error('handler exploded');
}`
      );
      const hook: HookDefinition = { match: 'Pre:tool:*', type: 'ts', path: filePath };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toContain('handler exploded');
    });

    test('nonexistent file returns error gracefully', async () => {
      const hook: HookDefinition = {
        match: 'Pre:tool:*',
        type: 'ts',
        path: '/nonexistent/path/to/hook-xyz.ts',
      };
      const result = await run(hook, makeEvent());
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
