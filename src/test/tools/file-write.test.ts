import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileWriteTool } from '../../tools/file-write.ts';
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

describe('FileWriteTool', () => {
  let tool: FileWriteTool;

  beforeEach(() => {
    tool = new FileWriteTool();
  });

  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('file_write');
  });

  test('writes a new file and returns success', async () => {
    const relPath = join(relDir, 'output.txt');
    const result = await tool.execute({ path: relPath, content: 'hello world' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('output.txt');

    const written = await Bun.file(join(tempDir, 'output.txt')).text();
    expect(written).toBe('hello world');
  });

  test('reports bytes written in output', async () => {
    const content = 'test content';
    const result = await tool.execute({ path: join(relDir, 'bytes.txt'), content });
    expect(result.success).toBe(true);
    expect(result.output).toContain(`${content.length}`);
  });

  test('creates parent directories automatically', async () => {
    const relPath = join(relDir, 'subdir/nested/file.ts');
    const result = await tool.execute({ path: relPath, content: 'export const x = 1;' });
    expect(result.success).toBe(true);

    const written = await Bun.file(join(tempDir, 'subdir/nested/file.ts')).text();
    expect(written).toBe('export const x = 1;');
  });

  test('overwrites an existing file', async () => {
    await Bun.write(join(tempDir, 'existing.txt'), 'original');
    const result = await tool.execute({ path: join(relDir, 'existing.txt'), content: 'updated' });
    expect(result.success).toBe(true);
    const written = await Bun.file(join(tempDir, 'existing.txt')).text();
    expect(written).toBe('updated');
  });

  test('returns error for missing path argument', async () => {
    const result = await tool.execute({ content: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: path');
  });

  test('returns error for missing content argument', async () => {
    const result = await tool.execute({ path: join(relDir, 'file.txt') });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: content');
  });

  test('returns error for path traversal attempt', async () => {
    const result = await tool.execute({ path: '../../../tmp/evil.txt', content: 'evil' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('returns error for empty path', async () => {
    const result = await tool.execute({ path: '', content: 'content' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: path');
  });

  test('writes empty content successfully', async () => {
    const result = await tool.execute({ path: join(relDir, 'empty.txt'), content: '' });
    expect(result.success).toBe(true);
    const written = await Bun.file(join(tempDir, 'empty.txt')).text();
    expect(written).toBe('');
  });
});
