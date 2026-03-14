import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GlobTool } from '../../tools/glob-tool.ts';
import { writeTempFile } from '../setup.ts';

const PROJECT_ROOT = process.cwd();

let tempDir: string;
let relDir: string;
let tool: GlobTool;

beforeEach(async () => {
  tempDir = await mkdtemp(join(PROJECT_ROOT, 'test-tmp-'));
  relDir = tempDir.replace(PROJECT_ROOT + '/', '');
  tool = new GlobTool();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('GlobTool', () => {
  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('glob');
  });

  test('definition has patterns as required field', () => {
    const params = tool.definition.parameters as { required: string[] };
    expect(params.required).toContain('patterns');
  });

  test('returns error when patterns argument is missing', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: patterns');
  });

  test('returns error when patterns is empty array', async () => {
    const result = await tool.execute({ patterns: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: patterns');
  });

  test('returns error for cwd outside project root', async () => {
    const result = await tool.execute({ patterns: ['*.ts'], cwd: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('returns no-match message when pattern finds nothing', async () => {
    const result = await tool.execute({ patterns: ['*.xyz'], cwd: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No files matched');
  });

  test('finds files matching a simple glob pattern', async () => {
    await writeTempFile(tempDir, 'foo.ts', 'content');
    await writeTempFile(tempDir, 'bar.ts', 'content');
    const result = await tool.execute({ patterns: ['*.ts'], cwd: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('foo.ts');
    expect(result.output).toContain('bar.ts');
  });

  test('filters by extension correctly', async () => {
    await writeTempFile(tempDir, 'code.ts', 'content');
    await writeTempFile(tempDir, 'readme.md', 'content');
    const result = await tool.execute({ patterns: ['*.ts'], cwd: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('code.ts');
    expect(result.output).not.toContain('readme.md');
  });

  test('multiple patterns find files matching any pattern', async () => {
    await writeTempFile(tempDir, 'code.ts', 'ts');
    await writeTempFile(tempDir, 'doc.md', 'md');
    await writeTempFile(tempDir, 'config.json', 'json');
    const result = await tool.execute({ patterns: ['*.ts', '*.md'], cwd: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('code.ts');
    expect(result.output).toContain('doc.md');
    expect(result.output).not.toContain('config.json');
  });

  test('output is sorted alphabetically', async () => {
    await writeTempFile(tempDir, 'z.ts', 'z');
    await writeTempFile(tempDir, 'a.ts', 'a');
    await writeTempFile(tempDir, 'm.ts', 'm');
    const result = await tool.execute({ patterns: ['*.ts'], cwd: relDir });
    expect(result.success).toBe(true);
    const lines = result.output!.split('\n').filter(Boolean);
    expect(lines[0]).toBe('a.ts');
    expect(lines[1]).toBe('m.ts');
    expect(lines[2]).toBe('z.ts');
  });

  test('recursive glob finds files in subdirectories', async () => {
    await mkdir(join(tempDir, 'sub'), { recursive: true });
    await writeTempFile(join(tempDir, 'sub'), 'nested.ts', 'content');
    const result = await tool.execute({ patterns: ['**/*.ts'], cwd: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('nested.ts');
  });

  test('respects maxResults limit', async () => {
    for (let i = 0; i < 5; i++) {
      await writeTempFile(tempDir, `file${i}.ts`, 'content');
    }
    const result = await tool.execute({ patterns: ['*.ts'], cwd: relDir, maxResults: 3 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated at 3');
  });

  test('uses process.cwd() when no cwd provided', async () => {
    // Just verify it doesn't error — it will search the whole project
    const result = await tool.execute({ patterns: ['package.json'] });
    expect(result.success).toBe(true);
  });
});
