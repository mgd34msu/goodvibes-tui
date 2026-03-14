import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileEditTool } from '../../tools/file-edit.ts';

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

describe('FileEditTool', () => {
  let tool: FileEditTool;

  beforeEach(() => {
    tool = new FileEditTool();
  });

  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('file_edit');
  });

  test('replaces a unique string and returns diff output', async () => {
    await Bun.write(join(tempDir, 'source.ts'), 'const x = 1;\nconst y = 2;\n');

    const result = await tool.execute({
      path: join(relDir, 'source.ts'),
      find: 'const x = 1;',
      replace: 'const x = 42;',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('--- ');
    expect(result.output).toContain('-const x = 1;');
    expect(result.output).toContain('+const x = 42;');

    const updated = await Bun.file(join(tempDir, 'source.ts')).text();
    expect(updated).toBe('const x = 42;\nconst y = 2;\n');
  });

  test('returns error when find string is not found', async () => {
    await Bun.write(join(tempDir, 'nofind.txt'), 'hello world');

    const result = await tool.execute({
      path: join(relDir, 'nofind.txt'),
      find: 'does not exist',
      replace: 'something',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('String not found');
  });

  test('returns error when find string is not unique', async () => {
    await Bun.write(join(tempDir, 'dupe.txt'), 'foo\nfoo\nfoo');

    const result = await tool.execute({
      path: join(relDir, 'dupe.txt'),
      find: 'foo',
      replace: 'bar',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('found 3 times');
  });

  test('returns error for missing path argument', async () => {
    const result = await tool.execute({ find: 'x', replace: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: path');
  });

  test('returns error for missing find argument', async () => {
    const result = await tool.execute({ path: join(relDir, 'file.txt'), replace: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: find');
  });

  test('returns error for missing replace argument', async () => {
    const result = await tool.execute({ path: join(relDir, 'file.txt'), find: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: replace');
  });

  test('returns error for path traversal attempt', async () => {
    const result = await tool.execute({
      path: '../../etc/shadow',
      find: 'root',
      replace: 'hacked',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('throws ToolError for non-existent file', async () => {
    const { ToolError } = await import('../../types/errors.ts');
    await expect(
      tool.execute({ path: join(relDir, 'missing.ts'), find: 'x', replace: 'y' })
    ).rejects.toBeInstanceOf(ToolError);
  });

  test('diff output includes hunk header', async () => {
    await Bun.write(join(tempDir, 'code.ts'), 'line1\nline2\nold_value\nline4\n');

    const result = await tool.execute({
      path: join(relDir, 'code.ts'),
      find: 'old_value',
      replace: 'new_value',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('@@');
  });

  test('handles multiline find and replace', async () => {
    const original = 'function foo() {\n  return 1;\n}';
    await Bun.write(join(tempDir, 'fn.ts'), original);

    const result = await tool.execute({
      path: join(relDir, 'fn.ts'),
      find: 'function foo() {\n  return 1;\n}',
      replace: 'function foo() {\n  return 42;\n}',
    });

    expect(result.success).toBe(true);
    const updated = await Bun.file(join(tempDir, 'fn.ts')).text();
    expect(updated).toContain('return 42');
  });
});
