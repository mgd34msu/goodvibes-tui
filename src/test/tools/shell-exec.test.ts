import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ShellExecTool } from '../../tools/shell-exec.ts';
import { writeTempFile } from '../setup.ts';

const PROJECT_ROOT = process.cwd();

let tempDir: string;
let relDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(PROJECT_ROOT, 'test-tmp-'));
  relDir = tempDir.replace(PROJECT_ROOT + '/', '');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ShellExecTool', () => {
  let tool: ShellExecTool;

  beforeEach(() => {
    tool = new ShellExecTool();
  });

  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('shell_exec');
  });

  test('executes a simple command and captures stdout', async () => {
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
    expect(result.output).toContain('Exit code: 0');
  });

  test('captures stderr output', async () => {
    const result = await tool.execute({ command: 'echo error_output >&2; exit 1' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('error_output');
    expect(result.output).toContain('stderr');
  });

  test('reports non-zero exit code as failure', async () => {
    const result = await tool.execute({ command: 'exit 2' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Exit code: 2');
  });

  test('uses cwd argument for working directory', async () => {
    const subdir = join(tempDir, 'workdir');
    await mkdir(subdir, { recursive: true });

    const result = await tool.execute({ command: 'pwd', cwd: subdir });
    expect(result.success).toBe(true);
    expect(result.output).toContain(subdir);
  });

  test('returns error for missing command argument', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: command');
  });

  test('returns error for empty command string', async () => {
    const result = await tool.execute({ command: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: command');
  });

  test('returns error for cwd outside project root', async () => {
    const result = await tool.execute({ command: 'pwd', cwd: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('times out slow commands', async () => {
    const result = await tool.execute({ command: 'sleep 60', timeout: 50 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 5000);

  test('command with both stdout and stderr', async () => {
    const result = await tool.execute({
      command: 'echo out_line; echo err_line >&2',
    });
    expect(result.output).toContain('out_line');
    expect(result.output).toContain('err_line');
  });

  test('executes in project root by default', async () => {
    const result = await tool.execute({ command: 'pwd' });
    expect(result.success).toBe(true);
    // Default cwd is process.cwd() which is the project root
    expect(result.output).toContain(PROJECT_ROOT);
  });
});
