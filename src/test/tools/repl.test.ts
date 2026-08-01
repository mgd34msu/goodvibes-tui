// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReplTool } from '@pellux/goodvibes-sdk/platform/tools';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { createTestConfigManager } from '../helpers/test-managers.ts';

let workspaceRoot = process.cwd();
let sandboxSessionRegistry = new SandboxSessionRegistry(workspaceRoot);
let replTool = createReplTool(createTestConfigManager(), sandboxSessionRegistry, { surfaceRoot: 'tui' });
const tempRoot = join(process.cwd(), '.test-tmp');

function withWorkspace(input: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceRoot,
    ...input,
  };
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  workspaceRoot = mkdtempSync(join(tempRoot, 'goodvibes-repl-'));
  sandboxSessionRegistry = new SandboxSessionRegistry(workspaceRoot);
  replTool = createReplTool(createTestConfigManager(), sandboxSessionRegistry, { surfaceRoot: 'tui' });
});

afterEach(() => {
  if (workspaceRoot.startsWith(tempRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

describe('repl tool', () => {
  test('requires configured QEMU sandbox backend for javascript eval', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '1 + 2' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires an explicit QEMU sandbox backend');
  });

  test('requires configured QEMU sandbox backend for typescript eval', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'typescript', expression: 'const value: number = 4; value * 2;' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires an explicit QEMU sandbox backend');
  });

  test('requires configured QEMU sandbox backend for SQL eval', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'sql', expression: 'select value from sandbox_eval order by id;' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires an explicit QEMU sandbox backend');
  });

  test('requires configured QEMU sandbox backend for GraphQL eval', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'graphql', expression: 'query Viewer { viewer { id name } }' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires an explicit QEMU sandbox backend');
  });

  test('records runtime-tagged history entries', async () => {
    const historyPath = join(workspaceRoot, '.goodvibes', 'tui', 'repl-history.json');
    rmSync(historyPath, { force: true });
    await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '7 * 6' }));
    const history = await replTool.execute(withWorkspace({ mode: 'history' }));
    expect(history.success).toBe(true);
    expect(history.output).toContain('"runtime":"javascript"');
    expect(existsSync(historyPath)).toBe(true);
  });

  test('records sandbox session startup metadata when eval is blocked before execution', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '21 + 21' }));
    expect(result.success).toBe(false);
    const sessions = sandboxSessionRegistry.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.profileId).toBe('eval-js');
    expect(sessions[0]?.label).toBe('repl:javascript');
    expect(sessions[0]?.executionCount).toBeUndefined();
  });

  test('requires configured QEMU sandbox backend for python eval', async () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'python', expression: '[x * 2 for x in range(3)]' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires an explicit QEMU sandbox backend');
  });

  test('requires an explicit workspace root', async () => {
    const result = await replTool.execute({ mode: 'history' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspaceRoot');
  });
});
