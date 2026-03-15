import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeTempDir, writeTempFile } from '../setup.ts';
import { findTool } from '../../tools/find/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function find(args: Record<string, unknown>) {
  const result = await findTool.execute(args);
  if (!result.success) throw new Error(result.error ?? 'find tool failed');
  return JSON.parse(result.output!) as Record<string, unknown>;
}

function queryResult<T = Record<string, unknown>>(results: Record<string, unknown>, id: string): T {
  return results[id] as T;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmp = await makeTempDir();
  dir = tmp.dir;
  cleanup = tmp.cleanup;

  // Create a realistic project structure
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'src/utils'), { recursive: true });
  await mkdir(join(dir, 'src/components'), { recursive: true });
  await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
  await mkdir(join(dir, '.git'), { recursive: true });
  await mkdir(join(dir, 'dist'), { recursive: true });

  await writeTempFile(dir, 'src/index.ts', `export function main() {\n  return 'hello';\n}\n`);
  await writeTempFile(
    dir,
    'src/utils/helper.ts',
    `export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n\nexport const VERSION = '1.0.0';\n`,
  );
  await writeTempFile(
    dir,
    'src/components/Button.tsx',
    `export class Button {\n  render() { return null; }\n}\n\nexport interface ButtonProps {\n  label: string;\n}\n`,
  );
  await writeTempFile(
    dir,
    'src/types.ts',
    `export type UserId = string;\nexport enum Status { Active = 'active', Inactive = 'inactive' }\n`,
  );
  await writeTempFile(dir, 'README.md', '# Test Project\n\nA sample project.\n');
  await writeTempFile(dir, 'package.json', '{"name":"test","version":"1.0.0"}');

  // Binary file (null bytes)
  const binaryBuf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]);
  await Bun.write(join(dir, 'src/image.png'), binaryBuf);

  // File in ignored dirs (should not appear)
  await writeTempFile(dir, 'node_modules/pkg/index.js', 'module.exports = 42;');
  await writeTempFile(dir, '.git/HEAD', 'ref: refs/heads/main');
  await writeTempFile(dir, 'dist/bundle.js', 'var x = 1;');
});

afterEach(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// files mode
// ---------------------------------------------------------------------------

describe('files mode', () => {
  test('basic glob — matches .ts files', async () => {
    const results = await find({
      queries: [{ id: 'ts', mode: 'files', patterns: ['**/*.ts'], path: dir }],
    });
    const r = queryResult<{ files: string[]; count: number }>(results, 'ts');
    expect(r.count).toBeGreaterThan(0);
    expect(r.files.every((f: string) => f.endsWith('.ts'))).toBe(true);
  });

  test('basic glob — matches .tsx files', async () => {
    const results = await find({
      queries: [{ id: 'tsx', mode: 'files', patterns: ['**/*.tsx'], path: dir }],
    });
    const r = queryResult<{ files: string[]; count: number }>(results, 'tsx');
    expect(r.files.length).toBeGreaterThanOrEqual(1);
    expect(r.files.some((f: string) => f.includes('Button.tsx'))).toBe(true);
  });

  test('exclude patterns remove matched files', async () => {
    const results = await find({
      queries: [{
        id: 'no_types',
        mode: 'files',
        patterns: ['**/*.ts'],
        exclude: ['**/types.ts'],
        path: dir,
      }],
    });
    const r = queryResult<{ files: string[] }>(results, 'no_types');
    expect(r.files.every((f: string) => !f.endsWith('types.ts'))).toBe(true);
  });

  test('multiple patterns union results', async () => {
    const results = await find({
      queries: [{
        id: 'multi',
        mode: 'files',
        patterns: ['**/*.ts', '**/*.tsx'],
        path: dir,
      }],
    });
    const r = queryResult<{ files: string[] }>(results, 'multi');
    expect(r.files.some((f: string) => f.endsWith('.ts'))).toBe(true);
    expect(r.files.some((f: string) => f.endsWith('.tsx'))).toBe(true);
  });

  test('count_only format returns count without files array', async () => {
    const results = await find({
      queries: [{ id: 'cnt', mode: 'files', patterns: ['**/*.ts'], path: dir }],
      output: { format: 'count_only' },
    });
    const r = queryResult<{ count: number; files?: string[] }>(results, 'cnt');
    expect(typeof r.count).toBe('number');
    expect(r.files).toBeUndefined();
  });

  test('max_results limits file count', async () => {
    const results = await find({
      queries: [{ id: 'lim', mode: 'files', patterns: ['**/*'], path: dir }],
      output: { max_results: 2 },
    });
    const r = queryResult<{ files: string[] }>(results, 'lim');
    expect(r.files.length).toBeLessThanOrEqual(2);
  });

  test('node_modules and .git are excluded', async () => {
    const results = await find({
      queries: [{ id: 'all', mode: 'files', patterns: ['**/*'], path: dir }],
    });
    const r = queryResult<{ files: string[] }>(results, 'all');
    expect(r.files.every((f: string) => !f.includes('node_modules'))).toBe(true);
    expect(r.files.every((f: string) => !f.includes('/.git/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// content mode
// ---------------------------------------------------------------------------

describe('content mode', () => {
  test('finds files matching regex', async () => {
    const results = await find({
      queries: [{ id: 'exp', mode: 'content', pattern: 'export function', path: dir }],
    });
    const r = queryResult<{ matches: Array<{ file: string; line: number; text: string }> }>(results, 'exp');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0]).toHaveProperty('file');
    expect(r.matches[0]).toHaveProperty('line');
    expect(r.matches[0]).toHaveProperty('text');
  });

  test('case insensitive search', async () => {
    const results = await find({
      queries: [{ id: 'ci', mode: 'content', pattern: 'EXPORT FUNCTION', path: dir, case_sensitive: false }],
    });
    const r = queryResult<{ count: number }>(results, 'ci');
    expect(r.count).toBeGreaterThan(0);
  });

  test('case sensitive (default) does not match wrong case', async () => {
    const results = await find({
      queries: [{ id: 'cs', mode: 'content', pattern: 'EXPORT FUNCTION', path: dir }],
    });
    const r = queryResult<{ count: number }>(results, 'cs');
    expect(r.count).toBe(0);
  });

  test('whole_word prevents partial matches', async () => {
    // 'main' should not match 'mainly'
    await writeTempFile(dir, 'src/mainly.ts', 'export function mainly() {}');

    const withWord = await find({
      queries: [{ id: 'ww', mode: 'content', pattern: 'main', path: dir, whole_word: true }],
      output: { format: 'files_only' },
    });
    const withoutWord = await find({
      queries: [{ id: 'nww', mode: 'content', pattern: 'main', path: dir, whole_word: false }],
      output: { format: 'files_only' },
    });

    const wwFiles = queryResult<{ files: string[] }>(withWord, 'ww').files;
    const nwwFiles = queryResult<{ files: string[] }>(withoutWord, 'nww').files;

    // Without whole_word, 'mainly' file should match
    expect(nwwFiles.some((f: string) => f.includes('mainly.ts'))).toBe(true);
    // With whole_word, 'mainly' should not match (only 'main(' in index.ts)
    expect(wwFiles.every((f: string) => !f.includes('mainly.ts'))).toBe(true);
  });

  test('multiline mode', async () => {
    await writeTempFile(dir, 'src/multi.ts', 'const x =\n  42;');
    const results = await find({
      queries: [{ id: 'ml', mode: 'content', pattern: 'const x', path: dir, multiline: true }],
    });
    const r = queryResult<{ count: number }>(results, 'ml');
    expect(r.count).toBeGreaterThan(0);
  });

  test('negate returns files without pattern', async () => {
    const results = await find({
      queries: [{ id: 'neg', mode: 'content', pattern: 'export function', path: dir, negate: true }],
      output: { format: 'files_only' },
    });
    const r = queryResult<{ files: string[] }>(results, 'neg');
    // README.md and package.json don't have 'export function'
    expect(r.files.some((f: string) => f.endsWith('README.md') || f.endsWith('package.json'))).toBe(true);
    // Files with 'export function' should not be in result
    expect(r.files.every((f: string) => !f.includes('index.ts'))).toBe(true);
  });

  test('count_only format', async () => {
    const results = await find({
      queries: [{ id: 'cnt', mode: 'content', pattern: 'export', path: dir }],
      output: { format: 'count_only' },
    });
    const r = queryResult<{ count: number; file_count: number }>(results, 'cnt');
    expect(typeof r.count).toBe('number');
    expect(r.count).toBeGreaterThan(0);
  });

  test('files_only format', async () => {
    const results = await find({
      queries: [{ id: 'fo', mode: 'content', pattern: 'export', path: dir }],
      output: { format: 'files_only' },
    });
    const r = queryResult<{ files: string[]; count: number }>(results, 'fo');
    expect(Array.isArray(r.files)).toBe(true);
    expect(r.files.every((f: string) => typeof f === 'string')).toBe(true);
  });

  test('locations format includes file and line', async () => {
    const results = await find({
      queries: [{ id: 'loc', mode: 'content', pattern: 'export', path: dir }],
      output: { format: 'locations' },
    });
    const r = queryResult<{ locations: Array<{ file: string; line: number }> }>(results, 'loc');
    expect(Array.isArray(r.locations)).toBe(true);
    expect(r.locations[0]).toHaveProperty('file');
    expect(r.locations[0]).toHaveProperty('line');
    expect(typeof r.locations[0].line).toBe('number');
  });

  test('matches format includes file, line, text', async () => {
    const results = await find({
      queries: [{ id: 'mat', mode: 'content', pattern: 'export function', path: dir }],
      output: { format: 'matches' },
    });
    const r = queryResult<{ matches: Array<{ file: string; line: number; text: string }> }>(results, 'mat');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].text).toContain('export function');
  });

  test('context format includes surrounding lines', async () => {
    const results = await find({
      queries: [{ id: 'ctx', mode: 'content', pattern: 'return', path: dir }],
      output: { format: 'context', context_before: 1, context_after: 1 },
    });
    const r = queryResult<{ matches: Array<{ context_before: string[]; context_after: string[] }> }>(results, 'ctx');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(Array.isArray(r.matches[0].context_before)).toBe(true);
    expect(Array.isArray(r.matches[0].context_after)).toBe(true);
  });

  test('glob filter restricts searched files', async () => {
    const allResults = await find({
      queries: [{ id: 'all', mode: 'content', pattern: 'export', path: dir }],
      output: { format: 'files_only' },
    });
    const filteredResults = await find({
      queries: [{ id: 'filt', mode: 'content', pattern: 'export', glob: '**/*.md', path: dir }],
      output: { format: 'files_only' },
    });
    const allFiles = queryResult<{ files: string[] }>(allResults, 'all').files;
    const filtFiles = queryResult<{ files: string[] }>(filteredResults, 'filt').files;
    // Glob filter should produce fewer or equal results
    expect(filtFiles.length).toBeLessThanOrEqual(allFiles.length);
    expect(filtFiles.every((f: string) => f.endsWith('.md'))).toBe(true);
  });

  test('binary files are skipped in content search', async () => {
    const results = await find({
      queries: [{ id: 'bin', mode: 'content', pattern: '.', path: dir }],
      output: { format: 'files_only' },
    });
    const r = queryResult<{ files: string[] }>(results, 'bin');
    expect(r.files.every((f: string) => !f.endsWith('.png'))).toBe(true);
  });

  test('max_results limits total matches', async () => {
    const results = await find({
      queries: [{ id: 'lim', mode: 'content', pattern: 'e', path: dir }],
      output: { max_results: 3, format: 'matches' },
    });
    const r = queryResult<{ matches: unknown[] }>(results, 'lim');
    expect(r.matches.length).toBeLessThanOrEqual(3);
  });

  test('invalid regex returns error', async () => {
    const result = await findTool.execute({
      queries: [{ id: 'bad', mode: 'content', pattern: '[invalid', path: dir }],
    });
    expect(result.success).toBe(true); // tool never throws
    const parsed = JSON.parse(result.output!);
    expect(parsed.bad).toHaveProperty('error');
  });

  test('missing pattern returns error', async () => {
    const result = await findTool.execute({
      queries: [{ id: 'nopattern', mode: 'content', path: dir }],
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.nopattern).toHaveProperty('error');
  });

  test('pattern_base64 is decoded and used', async () => {
    // Base64 of 'export'
    const b64 = Buffer.from('export').toString('base64');
    const results = await find({
      queries: [{ id: 'b64', mode: 'content', pattern_base64: b64, path: dir }],
      output: { format: 'count_only' },
    });
    const r = queryResult<{ count: number }>(results, 'b64');
    expect(r.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// symbols mode
// ---------------------------------------------------------------------------

describe('symbols mode', () => {
  test('finds exported functions', async () => {
    const results = await find({
      queries: [{ id: 'fn', mode: 'symbols', kinds: ['function'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string; kind: string; exported: boolean }> }>(results, 'fn');
    expect(r.symbols.length).toBeGreaterThan(0);
    expect(r.symbols.every((s) => s.kind === 'function')).toBe(true);
  });

  test('finds exported classes', async () => {
    const results = await find({
      queries: [{ id: 'cls', mode: 'symbols', kinds: ['class'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string; kind: string }> }>(results, 'cls');
    expect(r.symbols.some((s) => s.name === 'Button')).toBe(true);
  });

  test('finds exported interfaces', async () => {
    const results = await find({
      queries: [{ id: 'iface', mode: 'symbols', kinds: ['interface'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string }> }>(results, 'iface');
    expect(r.symbols.some((s) => s.name === 'ButtonProps')).toBe(true);
  });

  test('finds exported types', async () => {
    const results = await find({
      queries: [{ id: 'type', mode: 'symbols', kinds: ['type'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string }> }>(results, 'type');
    expect(r.symbols.some((s) => s.name === 'UserId')).toBe(true);
  });

  test('finds enums', async () => {
    const results = await find({
      queries: [{ id: 'enm', mode: 'symbols', kinds: ['enum'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string }> }>(results, 'enm');
    expect(r.symbols.some((s) => s.name === 'Status')).toBe(true);
  });

  test('finds constants', async () => {
    const results = await find({
      queries: [{ id: 'cnst', mode: 'symbols', kinds: ['constant'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string }> }>(results, 'cnst');
    expect(r.symbols.some((s) => s.name === 'VERSION')).toBe(true);
  });

  test('filter by kinds returns only matching kinds', async () => {
    const results = await find({
      queries: [{ id: 'mixed', mode: 'symbols', kinds: ['function', 'class'], path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ kind: string }> }>(results, 'mixed');
    expect(r.symbols.every((s) => s.kind === 'function' || s.kind === 'class')).toBe(true);
  });

  test('exported_only excludes non-exported symbols', async () => {
    await writeTempFile(
      dir,
      'src/internal.ts',
      'function internalHelper() {}\nexport function publicHelper() {}\n',
    );
    const results = await find({
      queries: [{ id: 'exp', mode: 'symbols', exported_only: true, path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string; exported: boolean }> }>(results, 'exp');
    expect(r.symbols.every((s) => s.exported === true)).toBe(true);
    expect(r.symbols.every((s) => s.name !== 'internalHelper')).toBe(true);
  });

  test('query pattern filters by symbol name', async () => {
    const results = await find({
      queries: [{ id: 'q', mode: 'symbols', query: 'format', path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ name: string }> }>(results, 'q');
    expect(r.symbols.every((s) => /format/i.test(s.name))).toBe(true);
  });

  test('symbols include file and line number', async () => {
    const results = await find({
      queries: [{ id: 'loc', mode: 'symbols', path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ file: string; line: number }> }>(results, 'loc');
    expect(r.symbols.length).toBeGreaterThan(0);
    expect(typeof r.symbols[0].file).toBe('string');
    expect(typeof r.symbols[0].line).toBe('number');
    expect(r.symbols[0].line).toBeGreaterThan(0);
  });

  test('count_only format for symbols', async () => {
    const results = await find({
      queries: [{ id: 'cnt', mode: 'symbols', path: dir }],
      output: { format: 'count_only' },
    });
    const r = queryResult<{ count: number }>(results, 'cnt');
    expect(typeof r.count).toBe('number');
    expect(r.count).toBeGreaterThan(0);
  });

  test('files_only format for symbols', async () => {
    const results = await find({
      queries: [{ id: 'fo', mode: 'symbols', path: dir }],
      output: { format: 'files_only' },
    });
    const r = queryResult<{ files: string[]; count: number }>(results, 'fo');
    expect(Array.isArray(r.files)).toBe(true);
    expect(r.files.every((f: string) => typeof f === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch queries
// ---------------------------------------------------------------------------

describe('batch queries', () => {
  test('multiple queries return results keyed by id', async () => {
    const results = await find({
      queries: [
        { id: 'ts_files', mode: 'files', patterns: ['**/*.ts'], path: dir },
        { id: 'exports', mode: 'content', pattern: 'export', path: dir },
        { id: 'fns', mode: 'symbols', kinds: ['function'], path: dir },
      ],
    });
    expect(results).toHaveProperty('ts_files');
    expect(results).toHaveProperty('exports');
    expect(results).toHaveProperty('fns');
  });

  test('parallel: false produces same results as parallel: true', async () => {
    const parallelResult = await find({
      queries: [
        { id: 'a', mode: 'files', patterns: ['**/*.ts'], path: dir },
        { id: 'b', mode: 'content', pattern: 'export', path: dir },
      ],
      parallel: true,
    });
    const seqResult = await find({
      queries: [
        { id: 'a', mode: 'files', patterns: ['**/*.ts'], path: dir },
        { id: 'b', mode: 'content', pattern: 'export', path: dir },
      ],
      parallel: false,
    });
    const pA = queryResult<{ count: number }>(parallelResult, 'a');
    const sA = queryResult<{ count: number }>(seqResult, 'a');
    expect(pA.count).toBe(sA.count);
  });

  test('each query uses its own id as the key', async () => {
    const results = await find({
      queries: [
        { id: 'query_one', mode: 'files', patterns: ['**/*.md'], path: dir },
        { id: 'query_two', mode: 'files', patterns: ['**/*.json'], path: dir },
      ],
    });
    expect(Object.keys(results)).toContain('query_one');
    expect(Object.keys(results)).toContain('query_two');
    expect(Object.keys(results)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('binary files are skipped in file walk (symbols/content)', async () => {
    const results = await find({
      queries: [{ id: 'syms', mode: 'symbols', path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ file: string }> }>(results, 'syms');
    expect(r.symbols.every((s) => !s.file.endsWith('.png'))).toBe(true);
  });

  test('max_results limits symbols output', async () => {
    const results = await find({
      queries: [{ id: 'lim', mode: 'symbols', path: dir }],
      output: { max_results: 2 },
    });
    const r = queryResult<{ symbols: unknown[] }>(results, 'lim');
    expect(r.symbols.length).toBeLessThanOrEqual(2);
  });

  test('empty results when no files match glob', async () => {
    const results = await find({
      queries: [{ id: 'none', mode: 'files', patterns: ['**/*.xyz'], path: dir }],
    });
    const r = queryResult<{ files: string[]; count: number }>(results, 'none');
    expect(r.count).toBe(0);
    expect(r.files).toHaveLength(0);
  });

  test('empty results when content pattern matches nothing', async () => {
    const results = await find({
      queries: [{ id: 'none', mode: 'content', pattern: 'DOES_NOT_EXIST_XYZ_42', path: dir }],
      output: { format: 'count_only' },
    });
    const r = queryResult<{ count: number }>(results, 'none');
    expect(r.count).toBe(0);
  });

  test('empty queries array returns error', async () => {
    const result = await findTool.execute({ queries: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/queries/);
  });

  test('dist and node_modules not walked in symbols mode', async () => {
    const results = await find({
      queries: [{ id: 'syms', mode: 'symbols', path: dir }],
    });
    const r = queryResult<{ symbols: Array<{ file: string }> }>(results, 'syms');
    expect(r.symbols.every((s) => !s.file.includes('node_modules'))).toBe(true);
    expect(r.symbols.every((s) => !s.file.includes('/dist/'))).toBe(true);
  });

  test('tool definition has correct name and schema shape', () => {
    expect(findTool.definition.name).toBe('find');
    expect(findTool.definition.parameters).toHaveProperty('type', 'object');
    expect(findTool.definition.parameters).toHaveProperty('required');
    const req = (findTool.definition.parameters as Record<string, unknown>).required as string[];
    expect(req).toContain('queries');
  });

  test('non-existent path inside project root returns empty results gracefully', async () => {
    const result = await findTool.execute({
      queries: [{ id: 'missing', mode: 'files', patterns: ['**/*'], path: 'tmp/does_not_exist_xyz_9999' }],
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.missing).toHaveProperty('count');
  });

  test('absolute path outside project root is blocked', async () => {
    for (const mode of ['files', 'content', 'symbols'] as const) {
      const result = await findTool.execute({
        queries: [{ id: 'blocked', mode, path: '/etc', pattern: 'test', patterns: ['**/*'] }],
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output!);
      expect(parsed.blocked).toHaveProperty('error');
      expect((parsed.blocked as { error: string }).error).toMatch(/outside the project root/);
    }
  });
});
