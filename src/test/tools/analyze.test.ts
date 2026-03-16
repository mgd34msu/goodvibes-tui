import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeTempDir, writeTempFile } from '../setup.ts';
import { analyzeTool } from '../../tools/analyze/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function analyze(args: Record<string, unknown>) {
  const result = await analyzeTool.execute(args);
  if (!result.success) throw new Error(result.error ?? 'analyze tool failed');
  return JSON.parse(result.output!) as Record<string, unknown>;
}

async function analyzeMayFail(args: Record<string, unknown>) {
  return analyzeTool.execute(args);
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const tmp = await makeTempDir();
  dir = tmp.dir;
  cleanup = tmp.cleanup;

  await mkdir(join(dir, 'src'), { recursive: true });

  // src/index.ts — exports: greet(), helper()
  await writeTempFile(
    dir,
    'src/index.ts',
    [
      "import { format } from './utils';",
      '',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      'export function helper(): string {',
      "  return format('helper');",
      '}',
    ].join('\n'),
  );

  // src/utils.ts — exports: format(), unused()
  await writeTempFile(
    dir,
    'src/utils.ts',
    [
      "import { User } from './types';",
      '',
      'export function format(s: string): string {',
      '  return s.trim();',
      '}',
      '',
      'export function unused(): void {',
      '  // never referenced anywhere',
      '}',
    ].join('\n'),
  );

  // src/types.ts — exports: User, Config
  await writeTempFile(
    dir,
    'src/types.ts',
    [
      'export interface User {',
      '  id: string;',
      '  name: string;',
      '}',
      '',
      'export interface Config {',
      '  debug: boolean;',
      '}',
    ].join('\n'),
  );

  // package.json
  await writeTempFile(
    dir,
    'package.json',
    JSON.stringify({ name: 'analyze-test', version: '1.0.0' }, null, 2),
  );
});

afterEach(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// dependencies — analyze
// ---------------------------------------------------------------------------

describe('dependencies mode', () => {
  test('analyze: returns import graph for project files', async () => {
    const result = await analyze({
      mode: 'dependencies',
      submode: 'analyze',
      projectRoot: dir,
      files: ['src'],
    });

    expect(result).toHaveProperty('graph');
    const graph = result.graph as Record<string, string[]>;
    // index.ts imports utils
    const indexKey = Object.keys(graph).find((k) => k.includes('index'));
    expect(indexKey).toBeDefined();
    if (indexKey) {
      const deps = graph[indexKey];
      expect(deps.some((d) => d.includes('utils'))).toBe(true);
    }
  });

  test('analyze: graph includes all scanned files', async () => {
    const result = await analyze({
      mode: 'dependencies',
      submode: 'analyze',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('graph');
    const graph = result.graph as Record<string, string[]>;
    const keys = Object.keys(graph);
    expect(keys.some((k) => k.includes('utils'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // dependencies — circular
  // ---------------------------------------------------------------------------

  test('circular: detects no cycles in acyclic project', async () => {
    const result = await analyze({
      mode: 'dependencies',
      submode: 'circular',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('cycles');
    // The fixture has no circular deps
    expect(result.has_cycles).toBe(false);
  });

  test('circular: detects cycle when introduced', async () => {
    // Make index.ts import from types, types import from index
    await writeTempFile(
      dir,
      'src/index.ts',
      ["import { Config } from './types';", 'export function greet() {}'].join('\n'),
    );
    await writeTempFile(
      dir,
      'src/types.ts',
      ["import { greet } from './index';", 'export interface Config { debug: boolean; }'].join('\n'),
    );

    const result = await analyze({
      mode: 'dependencies',
      submode: 'circular',
      projectRoot: dir,
      files: ['src'],
    });

    expect(result).toHaveProperty('cycles');
    const cycles = result.cycles as string[][];
    expect(cycles.length).toBeGreaterThan(0);
    expect(result.has_cycles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dead_code
// ---------------------------------------------------------------------------

describe('dead_code mode', () => {
  test('finds unused() export', async () => {
    const result = await analyze({
      mode: 'dead_code',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('dead_exports');
    const dead = result.dead_exports as Array<{ name: string; file: string }>;
    const names = dead.map((d) => d.name);
    expect(names).toContain('unused');
  });

  test('does not flag referenced exports as dead', async () => {
    const result = await analyze({
      mode: 'dead_code',
      projectRoot: dir,
    });

    const dead = result.dead_exports as Array<{ name: string; file: string }>;
    const names = dead.map((d) => d.name);
    // format is imported by index.ts, should not be dead
    expect(names).not.toContain('format');
  });

  test('returns total_exports count', async () => {
    const result = await analyze({
      mode: 'dead_code',
      projectRoot: dir,
    });
    expect(typeof result.total_exports).toBe('number');
    expect(result.total_exports as number).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------

describe('security mode', () => {
  test('detects hardcoded API key (sk- prefix)', async () => {
    await writeTempFile(
      dir,
      'src/config.ts',
      "const apiKey = 'sk-aBcDeFgHiJkLmNoPqRsTuVwX';\nexport { apiKey };",
    );

    const result = await analyze({
      mode: 'security',
      securityScope: 'secrets',
      projectRoot: dir,
    });

    const secrets = result.secrets as { findings: Array<{ pattern: string; file: string }> };
    expect(secrets.findings.length).toBeGreaterThan(0);
    expect(secrets.findings[0].pattern).toBe('api_key_prefix');
  });

  test('detects token assignment pattern', async () => {
    await writeTempFile(
      dir,
      'src/auth.ts',
      "const token = 'my-secret-token-value-here';\nexport { token };",
    );

    const result = await analyze({
      mode: 'security',
      securityScope: 'secrets',
      projectRoot: dir,
    });

    const secrets = result.secrets as { findings: Array<{ pattern: string }> };
    const tokenFindings = secrets.findings.filter((f) => f.pattern === 'token_assignment');
    expect(tokenFindings.length).toBeGreaterThan(0);
  });

  test('returns env scope results', async () => {
    const result = await analyze({
      mode: 'security',
      securityScope: 'env',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('env');
    const env = result.env as { files_found: string[] };
    expect(Array.isArray(env.files_found)).toBe(true);
  });

  test('all scope returns secrets and permissions and env', async () => {
    const result = await analyze({
      mode: 'security',
      securityScope: 'all',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('secrets');
    expect(result).toHaveProperty('env');
    expect(result).toHaveProperty('permissions');
  });
});

// ---------------------------------------------------------------------------
// surface
// ---------------------------------------------------------------------------

describe('surface mode', () => {
  test('returns exported symbols from file', async () => {
    const result = await analyze({
      mode: 'surface',
      files: ['src/index.ts'],
      projectRoot: dir,
    });

    expect(result).toHaveProperty('surface');
    const surface = result.surface as Array<{ file: string; exports: Array<{ name: string }> }>;
    expect(surface.length).toBe(1);
    const names = surface[0].exports.map((e) => e.name);
    expect(names).toContain('greet');
    expect(names).toContain('helper');
  });

  test('returns exports from types file', async () => {
    const result = await analyze({
      mode: 'surface',
      files: ['src/types.ts'],
      projectRoot: dir,
    });

    const surface = result.surface as Array<{ exports: Array<{ name: string }> }>;
    const names = surface[0]?.exports.map((e) => e.name) ?? [];
    expect(names).toContain('User');
    expect(names).toContain('Config');
  });

  test('reports total_exports', async () => {
    const result = await analyze({
      mode: 'surface',
      files: ['src/index.ts'],
      projectRoot: dir,
    });
    expect(typeof result.total_exports).toBe('number');
    expect(result.total_exports as number).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

describe('preview mode', () => {
  test('shows diff without writing file', async () => {
    const result = await analyze({
      mode: 'preview',
      files: ['src/utils.ts'],
      find: 'unused',
      replace: 'usedNow',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('diff');
    const diff = result.diff as string;
    expect(diff).toContain('-');
    expect(diff).toContain('+');

    // Verify file was NOT modified
    const content = await Bun.file(join(dir, 'src/utils.ts')).text();
    expect(content).toContain('unused');
    expect(content).not.toContain('usedNow');
  });

  test('returns error when string not found', async () => {
    const result = await analyzeMayFail({
      mode: 'preview',
      files: ['src/utils.ts'],
      find: 'THIS_DOES_NOT_EXIST_XYZ',
      replace: 'replacement',
      projectRoot: dir,
    });
    // Either success: false, or success: true with error field
    if (result.success) {
      const parsed = JSON.parse(result.output!);
      expect(parsed).toHaveProperty('error');
    } else {
      expect(result.error).toBeDefined();
    }
  });

  test('returns find and replace in result', async () => {
    const result = await analyze({
      mode: 'preview',
      files: ['src/utils.ts'],
      find: 'format',
      replace: 'fmt',
      projectRoot: dir,
    });

    expect(result.find).toBe('format');
    expect(result.replace).toBe('fmt');
  });
});

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------

describe('impact mode', () => {
  test('finds files affected by changing greet()', async () => {
    // Add a consumer that uses greet
    await writeTempFile(
      dir,
      'src/app.ts',
      ["import { greet } from './index';", "console.log(greet('world'));"].join('\n'),
    );

    const result = await analyze({
      mode: 'impact',
      files: ['src/index.ts'],
      changes: 'Changed greet() signature',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('affected_files');
    const affected = result.affected_files as Array<{ file: string }>;
    const files = affected.map((a) => a.file);
    // app.ts references greet
    expect(files.some((f) => f.includes('app'))).toBe(true);
  });

  test('returns exported_names list', async () => {
    const result = await analyze({
      mode: 'impact',
      files: ['src/index.ts'],
      projectRoot: dir,
    });
    const names = result.exported_names as string[];
    expect(names).toContain('greet');
    expect(names).toContain('helper');
  });

  test('returns error when no files provided', async () => {
    const result = await analyzeMayFail({
      mode: 'impact',
      projectRoot: dir,
    });
    if (result.success) {
      const parsed = JSON.parse(result.output!);
      expect(parsed).toHaveProperty('error');
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// coverage — graceful missing file handling
// ---------------------------------------------------------------------------

describe('coverage mode', () => {
  test('returns error object when no coverage files exist', async () => {
    const result = await analyze({
      mode: 'coverage',
      projectRoot: dir,
    });
    // Should return an error field (no coverage directory in temp dir)
    expect(result).toHaveProperty('error');
  });

  test('parses coverage-summary.json when present', async () => {
    await mkdir(join(dir, 'coverage'), { recursive: true });
    await writeTempFile(
      dir,
      'coverage/coverage-summary.json',
      JSON.stringify({
        total: {
          lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
          statements: { total: 120, covered: 96, skipped: 0, pct: 80 },
          branches: { total: 40, covered: 30, skipped: 0, pct: 75 },
          functions: { total: 20, covered: 18, skipped: 0, pct: 90 },
        },
      }),
    );

    const result = await analyze({
      mode: 'coverage',
      projectRoot: dir,
    });

    expect(result.source).toBe('coverage-summary.json');
    expect(result).toHaveProperty('lines');
  });

  test('parses lcov.info when present (no summary)', async () => {
    await mkdir(join(dir, 'coverage'), { recursive: true });
    const lcov = [
      'SF:src/index.ts',
      'FN:1,greet',
      'FNDA:5,greet',
      'FNF:1',
      'FNH:1',
      'DA:1,5',
      'DA:2,5',
      'LF:2',
      'LH:2',
      'BRF:0',
      'BRH:0',
      'end_of_record',
    ].join('\n');
    await writeTempFile(dir, 'coverage/lcov.info', lcov);

    const result = await analyze({
      mode: 'coverage',
      projectRoot: dir,
    });

    expect(result.source).toBe('lcov.info');
    expect(result).toHaveProperty('lines');
    const lines = result.lines as { total: number; covered: number };
    expect(lines.total).toBe(2);
    expect(lines.covered).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// bundle — graceful missing file handling
// ---------------------------------------------------------------------------

describe('bundle mode', () => {
  test('returns error object when no stats files exist', async () => {
    const result = await analyze({
      mode: 'bundle',
      projectRoot: dir,
    });
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('searched');
  });

  test('parses stats.json when present', async () => {
    const stats = { assets: [{ name: 'main.js', size: 100000 }] };
    await writeTempFile(dir, 'stats.json', JSON.stringify(stats));

    const result = await analyze({
      mode: 'bundle',
      projectRoot: dir,
    });

    expect(result.source).toBe('stats.json');
    expect(result).toHaveProperty('data');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('error cases', () => {
  test('invalid mode returns error', async () => {
    const result = await analyzeMayFail({
      mode: 'not_a_valid_mode',
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('missing mode returns error', async () => {
    const result = await analyzeMayFail({
      projectRoot: dir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('mode');
  });

  test('preview without files returns error', async () => {
    const result = await analyze({
      mode: 'preview',
      find: 'something',
      replace: 'other',
      projectRoot: dir,
    });
    expect(result).toHaveProperty('error');
  });

  test('impact without files returns error result', async () => {
    const result = await analyze({
      mode: 'impact',
      projectRoot: dir,
    });
    // Returns { error: '...' } (not throws)
    expect(result).toHaveProperty('error');
  });
});
