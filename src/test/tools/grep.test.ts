import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { GrepTool } from '../../tools/grep.ts';
import { makeTempDir, writeTempFile } from '../setup.ts';

// Temp dirs are created inside the project root so path-safety validation passes.
const PROJECT_ROOT = process.cwd();

let tempDir: string;
let relDir: string;
let cleanup: () => Promise<void>;
let tool: GrepTool;

beforeEach(async () => {
  // makeTempDir from setup uses system tmpdir; grep tool uses resolveAndValidatePath
  // which requires paths inside project root. Create temp dir inside project root.
  const { mkdtemp } = await import('node:fs/promises');
  tempDir = await mkdtemp(join(PROJECT_ROOT, 'test-tmp-'));
  relDir = tempDir.replace(PROJECT_ROOT + '/', '');
  cleanup = async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tempDir, { recursive: true, force: true });
  };
  tool = new GrepTool();
});

afterEach(async () => {
  await cleanup();
});

describe('GrepTool', () => {
  test('has correct definition name', () => {
    expect(tool.definition.name).toBe('grep');
  });

  test('definition has pattern as required field', () => {
    const params = tool.definition.parameters as { required: string[] };
    expect(params.required).toContain('pattern');
  });

  test('returns error for missing pattern', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: pattern');
  });

  test('returns error for empty pattern', async () => {
    const result = await tool.execute({ pattern: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required argument: pattern');
  });

  test('returns error for invalid regex pattern', async () => {
    const result = await tool.execute({ pattern: '[invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex pattern');
  });

  test('returns error for pattern exceeding max length', async () => {
    const longPattern = 'a'.repeat(501);
    const result = await tool.execute({ pattern: longPattern });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum length');
  });

  test('returns error for path outside project root', async () => {
    const result = await tool.execute({ pattern: 'foo', path: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the project root');
  });

  test('finds matching line in a file', async () => {
    await writeTempFile(tempDir, 'search.txt', 'hello world\ngoodbye world\n');
    const result = await tool.execute({ pattern: 'hello', path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  test('reports line number in output', async () => {
    await writeTempFile(tempDir, 'lines.txt', 'line1\nline2\nmatch here\nline4');
    const result = await tool.execute({ pattern: 'match here', path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('3:');
  });

  test('returns no-matches message when pattern not found', async () => {
    await writeTempFile(tempDir, 'empty.txt', 'nothing to see here');
    const result = await tool.execute({ pattern: 'ZZZNOTFOUND', path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches found');
  });

  test('filters files by glob pattern', async () => {
    await writeTempFile(tempDir, 'code.ts', 'const x = 1;');
    await writeTempFile(tempDir, 'readme.md', 'const x = 1;');
    const result = await tool.execute({ pattern: 'const', path: relDir, glob: '*.ts' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('code.ts');
    expect(result.output).not.toContain('readme.md');
  });

  test('searches a single file directly', async () => {
    const filePath = await writeTempFile(tempDir, 'single.txt', 'findme\nskip');
    const result = await tool.execute({ pattern: 'findme', path: filePath });
    expect(result.success).toBe(true);
    expect(result.output).toContain('findme');
  });

  test('respects maxResults limit', async () => {
    // Write a file with many matching lines
    const lines = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join('\n');
    await writeTempFile(tempDir, 'many.txt', lines);
    const result = await tool.execute({ pattern: 'match', path: relDir, maxResults: 5 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated at 5');
  });

  test('includes file path prefix in each match', async () => {
    await writeTempFile(tempDir, 'named.txt', 'target content');
    const result = await tool.execute({ pattern: 'target', path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('named.txt');
  });

  test('returns no-matches for empty directory', async () => {
    const result = await tool.execute({ pattern: 'anything', path: relDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches found');
  });
});
