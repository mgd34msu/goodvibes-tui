import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileReadTool } from '../../tools/file-read.ts';
import { writeTempFile } from '../setup.ts';

// config.workingDir defaults to process.cwd() which is the project root.
// We create temp dirs INSIDE the project root so path-safety validation passes.
const PROJECT_ROOT = process.cwd();

let tempDir: string;
let relDir: string;

beforeEach(async () => {
  // Create temp subdir inside project root (passes path-safety check)
  tempDir = await mkdtemp(join(PROJECT_ROOT, 'test-tmp-'));
  relDir = tempDir.replace(PROJECT_ROOT + '/', '');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('FileReadTool', () => {
  let tool: FileReadTool;

  beforeEach(() => {
    tool = new FileReadTool();
  });

  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('file_read');
  });

  test('reads a file and returns its contents with line numbers', async () => {
    const filePath = join(tempDir, 'hello.txt');
    await Bun.write(filePath, 'line one\nline two\nline three');

    const result = await tool.execute({ path: join(relDir, 'hello.txt') });
    expect(result.success).toBe(true);
    expect(result.output).toContain('line one');
    expect(result.output).toContain('line two');
    expect(result.output).toContain('line three');
    expect(result.output).toContain('1 |');
  });

  test('reads a specific line range', async () => {
    const filePath = join(tempDir, 'range.txt');
    await Bun.write(filePath, 'a\nb\nc\nd\ne');

    const result = await tool.execute({ path: join(relDir, 'range.txt'), range: { start: 2, end: 4 } });
    expect(result.success).toBe(true);
    expect(result.output).toContain('b');
    expect(result.output).toContain('c');
    expect(result.output).toContain('d');
    expect(result.output).toContain('lines 2-4');
  });

  test('returns error for missing path argument', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: path');
  });

  test('returns error for empty path string', async () => {
    const result = await tool.execute({ path: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: path');
  });

  test('returns error for path traversal attempt', async () => {
    const result = await tool.execute({ path: '../../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('throws ToolError for non-existent file', async () => {
    const { ToolError } = await import('../../types/errors.ts');
    await expect(
      tool.execute({ path: join(relDir, 'does-not-exist.txt') })
    ).rejects.toBeInstanceOf(ToolError);
  });

  test('range is clamped to file bounds', async () => {
    const filePath = join(tempDir, 'short.txt');
    await Bun.write(filePath, 'only\ntwo\nlines');

    const result = await tool.execute({ path: join(relDir, 'short.txt'), range: { start: 1, end: 999 } });
    expect(result.success).toBe(true);
    expect(result.output).toContain('only');
    expect(result.output).toContain('lines');
  });

  test('output includes filename', async () => {
    await Bun.write(join(tempDir, 'named.txt'), 'content');
    const relPath = join(relDir, 'named.txt');
    const result = await tool.execute({ path: relPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain('named.txt');
  });

  test('reads file by absolute path within project root', async () => {
    await Bun.write(join(tempDir, 'abs.txt'), 'absolute path content');
    const result = await tool.execute({ path: join(tempDir, 'abs.txt') });
    expect(result.success).toBe(true);
    expect(result.output).toContain('absolute path content');
  });
});
