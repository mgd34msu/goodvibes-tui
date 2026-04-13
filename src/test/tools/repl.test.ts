import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReplTool } from '../../tools/repl/index.ts';
import { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.ts';
import { createTestConfigManager } from '../helpers/test-managers.ts';

let workspaceRoot = process.cwd();
let sandboxSessionRegistry = new SandboxSessionRegistry(workspaceRoot);
let replTool = createReplTool(createTestConfigManager(), sandboxSessionRegistry);

function withWorkspace(input: Record<string, unknown>): Record<string, unknown> {
  return {
    workspaceRoot,
    ...input,
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'goodvibes-repl-'));
  sandboxSessionRegistry = new SandboxSessionRegistry(workspaceRoot);
  replTool = createReplTool(createTestConfigManager(), sandboxSessionRegistry);
});

describe('repl tool', () => {
  test('evaluates javascript expressions', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '1 + 2' }));
    expect(result.success).toBe(true);
    expect(result.output).toBe('3');
  });

  test('evaluates typescript expressions', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'typescript', expression: 'const value: number = 4; value * 2;' }));
    expect(result.success).toBe(true);
    expect(result.output).toBe('8');
  });

  test('evaluates SQL expressions against ephemeral sqlite', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'sql', expression: 'select value from sandbox_eval order by id;' }));
    expect(result.success).toBe(true);
    expect(result.output).toContain('alpha');
    expect(result.output).toContain('beta');
  });

  test('normalizes graphql expressions into structured output', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'graphql', expression: 'query Viewer { viewer { id name } }' }));
    expect(result.success).toBe(true);
    expect(result.output).toContain('viewer');
    expect(result.output).toContain('"operation":"query"');
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

  test('records sandbox session execution metadata for eval runs', async () => {
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'javascript', expression: '21 + 21' }));
    expect(result.success).toBe(true);
    const sessions = sandboxSessionRegistry.list();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]?.executionCount).toBeGreaterThan(0);
    expect(sessions[0]?.lastCommandSummary).toContain(process.execPath);
    expect(sessions[0]?.lastExitStatus).toBe(0);
  });

  test('evaluates python expressions when python3 is available', async () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    const result = await replTool.execute(withWorkspace({ mode: 'eval', runtime: 'python', expression: '[x * 2 for x in range(3)]' }));
    expect(result.success).toBe(true);
    expect(result.output).toContain('[0, 2, 4]');
  });

  test('requires an explicit workspace root', async () => {
    const result = await replTool.execute({ mode: 'history' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspaceRoot');
  });
});
