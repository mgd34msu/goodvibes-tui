import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ListDirTool } from '../../tools/list-dir.ts';
import { writeTempFile } from '../setup.ts';

const PROJECT_ROOT = process.cwd();

let tempDir: string;
let relDir: string;
let tool: ListDirTool;

beforeEach(async () => {
  tempDir = await mkdtemp(join(PROJECT_ROOT, 'test-tmp-'));
  relDir = tempDir.replace(PROJECT_ROOT + '/', '');
  tool = new ListDirTool();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('ListDirTool', () => {
  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('list_dir');
  });

  test('returns empty directory message for empty dir', async () => {
    const result = await tool.execute({ path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toBe('(empty directory)');
  });

  test('lists files in a directory', async () => {
    await writeTempFile(tempDir, 'hello.ts', 'export const x = 1;');
    await writeTempFile(tempDir, 'world.ts', 'export const y = 2;');
    const result = await tool.execute({ path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello.ts');
    expect(result.output).toContain('world.ts');
  });

  test('lists subdirectories with trailing slash', async () => {
    await mkdir(join(tempDir, 'subdir'), { recursive: true });
    const result = await tool.execute({ path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('subdir/');
  });

  test('non-recursive listing does not descend into subdirectories', async () => {
    await mkdir(join(tempDir, 'sub'), { recursive: true });
    await writeTempFile(join(tempDir, 'sub'), 'deep.ts', 'content');
    const result = await tool.execute({ path: relDir, recursive: false });
    expect(result.success).toBe(true);
    // 'deep.ts' should not appear (it's inside sub/)
    expect(result.output).not.toContain('deep.ts');
    expect(result.output).toContain('sub/');
  });

  test('recursive listing descends into subdirectories', async () => {
    await mkdir(join(tempDir, 'sub'), { recursive: true });
    await writeTempFile(join(tempDir, 'sub'), 'deep.ts', 'content');
    const result = await tool.execute({ path: relDir, recursive: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain('deep.ts');
  });

  test('skips dotfiles', async () => {
    await writeTempFile(tempDir, '.hidden', 'secret');
    await writeTempFile(tempDir, 'visible.ts', 'public');
    const result = await tool.execute({ path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('.hidden');
    expect(result.output).toContain('visible.ts');
  });

  test('returns error for path outside project root', async () => {
    const result = await tool.execute({ path: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('includes file size in output', async () => {
    await writeTempFile(tempDir, 'sized.txt', 'hello world');
    const result = await tool.execute({ path: relDir });
    expect(result.success).toBe(true);
    // Should include a size annotation like (11B)
    expect(result.output).toMatch(/\d+B|\d+\.\d+KB|\d+\.\d+MB/);
  });

  test('respects maxDepth in recursive listing', async () => {
    await mkdir(join(tempDir, 'a/b/c'), { recursive: true });
    await writeTempFile(join(tempDir, 'a/b/c'), 'deep.ts', 'content');
    const result = await tool.execute({ path: relDir, recursive: true, maxDepth: 1 });
    expect(result.success).toBe(true);
    // With maxDepth=1, should see 'a/' and 'b/' but not 'c/' or 'deep.ts'
    expect(result.output).not.toContain('deep.ts');
  });

  test('uses absolute path successfully', async () => {
    await writeTempFile(tempDir, 'abs.ts', 'content');
    const result = await tool.execute({ path: tempDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('abs.ts');
  });
});
