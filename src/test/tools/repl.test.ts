import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { replTool } from '../../tools/repl/index.ts';
import { getSandboxSessionRegistry, resetSandboxSessionRegistryForTesting } from '../../runtime/sandbox/session-registry.ts';

const HISTORY_PATH = join('.goodvibes', 'tui', 'repl-history.json');

describe('repl tool', () => {
  test('evaluates javascript expressions', async () => {
    resetSandboxSessionRegistryForTesting();
    const result = await replTool.execute({ mode: 'eval', runtime: 'javascript', expression: '1 + 2' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('3');
  });

  test('evaluates typescript expressions', async () => {
    resetSandboxSessionRegistryForTesting();
    const result = await replTool.execute({ mode: 'eval', runtime: 'typescript', expression: 'const value: number = 4; value * 2;' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('8');
  });

  test('evaluates SQL expressions against ephemeral sqlite', async () => {
    resetSandboxSessionRegistryForTesting();
    const result = await replTool.execute({ mode: 'eval', runtime: 'sql', expression: 'select value from sandbox_eval order by id;' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('alpha');
    expect(result.output).toContain('beta');
  });

  test('normalizes graphql expressions into structured output', async () => {
    resetSandboxSessionRegistryForTesting();
    const result = await replTool.execute({ mode: 'eval', runtime: 'graphql', expression: 'query Viewer { viewer { id name } }' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('viewer');
    expect(result.output).toContain('"operation":"query"');
  });

  test('records runtime-tagged history entries', async () => {
    resetSandboxSessionRegistryForTesting();
    rmSync(HISTORY_PATH, { force: true });
    await replTool.execute({ mode: 'eval', runtime: 'javascript', expression: '7 * 6' });
    const history = await replTool.execute({ mode: 'history' });
    expect(history.success).toBe(true);
    expect(history.output).toContain('"runtime":"javascript"');
    expect(existsSync(HISTORY_PATH)).toBe(true);
  });

  test('records sandbox session execution metadata for eval runs', async () => {
    resetSandboxSessionRegistryForTesting();
    const result = await replTool.execute({ mode: 'eval', runtime: 'javascript', expression: '21 + 21' });
    expect(result.success).toBe(true);
    const sessions = getSandboxSessionRegistry().list();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]?.executionCount).toBeGreaterThan(0);
    expect(sessions[0]?.lastCommandSummary).toContain(process.execPath);
    expect(sessions[0]?.lastExitStatus).toBe(0);
  });

  test('evaluates python expressions when python3 is available', async () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    resetSandboxSessionRegistryForTesting();
    const result = await replTool.execute({ mode: 'eval', runtime: 'python', expression: '[x * 2 for x in range(3)]' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('[0, 2, 4]');
  });
});
