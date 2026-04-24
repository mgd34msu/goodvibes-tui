import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { makeTempDir, writeTempFile } from '../setup.ts';
import { createAnalyzeTool } from '@pellux/goodvibes-sdk/platform/tools/analyze/index';
import { GitService } from '@pellux/goodvibes-sdk/platform/git/service';
import { createTestManagers } from '../helpers/test-managers.ts';
import { getTestGitService } from '../helpers/runtime-services.ts';

let analyzeTool: ReturnType<typeof createAnalyzeTool>;

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
  analyzeTool = createAnalyzeTool(createTestManagers().toolLLM, null, dir);

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
// Shared git test helpers (used by diff, breaking, and semantic_diff suites)
// ---------------------------------------------------------------------------

/** Create an isolated temp git repo with a configured identity. */
function makeTempGitRepo(prefix = 'analyze-git-test'): string {
  const tmpDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  execSync('git init', { cwd: tmpDir });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir });
  execSync('git config user.name "Test"', { cwd: tmpDir });
  return tmpDir;
}

/** Write, stage, and commit a single file in the given repo. */
function addCommit(repoDir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(repoDir, filename), content);
  execSync(`git add ${filename}`, { cwd: repoDir });
  execSync(`git commit -m "${message}"`, { cwd: repoDir });
}

// ---------------------------------------------------------------------------
// diff mode
// ---------------------------------------------------------------------------

describe('diff mode', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = makeTempGitRepo();
  });

  afterEach(() => {
    // Dispose the shared test-owned intelligence service so it doesn't bleed between tests
    try { getTestGitService(gitDir).dispose(); } catch {}
    rmSync(gitDir, { recursive: true, force: true });
  });

  test('returns structured result with before/after/stat/files/diff', async () => {
    addCommit(gitDir, 'hello.txt', 'version1', 'first commit');
    addCommit(gitDir, 'hello.txt', 'version2', 'second commit');

    const result = await analyze({
      mode: 'diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    expect(result.before).toBe('HEAD~1');
    expect(result.after).toBe('HEAD');
    expect(typeof result.stat).toBe('string');
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.diff).toBe('string');
  });

  test('files array contains changed files with insertion/deletion counts', async () => {
    addCommit(gitDir, 'count.txt', 'line1', 'initial');
    addCommit(gitDir, 'count.txt', 'line1\nline2\nline3', 'add lines');

    const result = await analyze({
      mode: 'diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    const files = result.files as Array<{ file: string; insertions: number; deletions: number }>;
    expect(files.length).toBeGreaterThan(0);
    const changed = files.find((f) => f.file.includes('count.txt'));
    expect(changed).toBeDefined();
    expect(changed!.insertions).toBeGreaterThan(0);
  });

  test('diff field contains unified diff content', async () => {
    addCommit(gitDir, 'content.txt', 'old content', 'v1');
    addCommit(gitDir, 'content.txt', 'new content', 'v2');

    const result = await analyze({
      mode: 'diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    const diff = result.diff as string;
    expect(diff).toContain('content.txt');
    expect(diff).toContain('+new content');
    expect(diff).toContain('-old content');
  });

  test('invalid ref format returns error', async () => {
    const result = await analyzeMayFail({
      mode: 'diff',
      projectRoot: gitDir,
      before: 'HEAD; rm -rf /',
      after: 'HEAD',
    });

    if (result.success) {
      const parsed = JSON.parse(result.output!);
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toContain('Invalid git ref');
    } else {
      expect(result.error).toBeDefined();
    }
  });

  test('defaults to HEAD~1..HEAD when before/after not provided', async () => {
    addCommit(gitDir, 'default.txt', 'v1', 'first');
    addCommit(gitDir, 'default.txt', 'v2', 'second');

    const result = await analyze({
      mode: 'diff',
      projectRoot: gitDir,
    });

    expect(result.before).toBe('HEAD~1');
    expect(result.after).toBe('HEAD');
  });

  test('non-existent repo path returns error', async () => {
    const result = await analyzeMayFail({
      mode: 'diff',
      projectRoot: join(tmpdir(), 'nonexistent-repo-xyz-12345'),
      before: 'HEAD~1',
      after: 'HEAD',
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
// breaking mode
// ---------------------------------------------------------------------------

describe('breaking mode', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = makeTempGitRepo();
  });

  afterEach(() => {
    try { getTestGitService(gitDir).dispose(); } catch {}
    rmSync(gitDir, { recursive: true, force: true });
  });

  test('returns breaking_changes, additions, safe_modifications fields', async () => {
    addCommit(gitDir, 'api.ts', 'export function greet(name: string): string { return name; }', 'initial');
    addCommit(gitDir, 'api.ts', 'export function greet(name: string, greeting: string): string { return greeting + name; }', 'change signature');

    const result = await analyze({
      mode: 'breaking',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    expect(result).toHaveProperty('breaking_changes');
    expect(result).toHaveProperty('additions');
    expect(result).toHaveProperty('safe_modifications');
    expect(result).toHaveProperty('total_breaking');
    expect(result).toHaveProperty('total_additions');
  });

  test('detects removed export as breaking change', async () => {
    addCommit(
      gitDir,
      'api.ts',
      'export function greet(name: string): string { return name; }\nexport function helper(): void {}',
      'initial',
    );
    addCommit(gitDir, 'api.ts', 'export function greet(name: string): string { return name; }', 'remove helper');

    const result = await analyze({
      mode: 'breaking',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    const breaking = result.breaking_changes as Array<{ name: string; reason: string }>;
    const removed = breaking.find((b) => b.name === 'helper');
    expect(removed).toBeDefined();
    expect(removed!.reason).toBe('export removed');
    expect(result.total_breaking as number).toBeGreaterThan(0);
  });

  test('detects signature change as breaking', async () => {
    addCommit(gitDir, 'api.ts', 'export function compute(x: number): number { return x; }', 'initial');
    addCommit(gitDir, 'api.ts', 'export function compute(x: number, y: number): number { return x + y; }', 'add param');

    const result = await analyze({
      mode: 'breaking',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    const breaking = result.breaking_changes as Array<{ name: string; reason: string }>;
    const changed = breaking.find((b) => b.name === 'compute');
    expect(changed).toBeDefined();
    expect(changed!.reason).toBe('signature changed');
  });

  test('classifies new export as addition (non-breaking)', async () => {
    addCommit(gitDir, 'api.ts', 'export function greet(name: string): string { return name; }', 'initial');
    addCommit(
      gitDir,
      'api.ts',
      'export function greet(name: string): string { return name; }\nexport function newFn(): void {}',
      'add export',
    );

    const result = await analyze({
      mode: 'breaking',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    const additions = result.additions as Array<{ name: string }>;
    expect(additions.some((a) => a.name === 'newFn')).toBe(true);
    expect(result.total_breaking).toBe(0);
  });

  test('invalid ref returns error', async () => {
    const result = await analyzeMayFail({
      mode: 'breaking',
      projectRoot: gitDir,
      before: 'HEAD; rm -rf /',
      after: 'HEAD',
    });

    if (result.success) {
      const parsed = JSON.parse(result.output!);
      expect(parsed).toHaveProperty('error');
    } else {
      expect(result.error).toBeDefined();
    }
  });

  test('defaults to HEAD~1..HEAD when before/after omitted', async () => {
    addCommit(gitDir, 'api.ts', 'export function greet(name: string): string { return name; }', 'v1');
    addCommit(gitDir, 'api.ts', 'export function greet(name: string, lang: string): string { return name; }', 'v2');

    const result = await analyze({
      mode: 'breaking',
      projectRoot: gitDir,
    });

    expect(result.before).toBe('HEAD~1');
    expect(result.after).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// semantic_diff mode
// ---------------------------------------------------------------------------

describe('semantic_diff mode', () => {
  let gitDir: string;

  beforeEach(() => {
    gitDir = makeTempGitRepo();
  });

  afterEach(() => {
    try { getTestGitService(gitDir).dispose(); } catch {}
    rmSync(gitDir, { recursive: true, force: true });
  });

  test('returns summary, impact, risk, changed_files fields', async () => {
    addCommit(gitDir, 'service.ts', 'export function fetchUser(id: string) { return id; }', 'initial');
    addCommit(gitDir, 'service.ts', 'export async function fetchUser(id: string) { return { id }; }', 'make async');

    const result = await analyze({
      mode: 'semantic_diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('impact');
    expect(result).toHaveProperty('risk');
    expect(result).toHaveProperty('changed_files');
    expect(typeof result.summary).toBe('string');
    expect(Array.isArray(result.impact)).toBe(true);
  });

  test('risk is one of low|medium|high', async () => {
    addCommit(gitDir, 'util.ts', 'export const VERSION = 1;', 'initial');
    addCommit(gitDir, 'util.ts', 'export const VERSION = 2;', 'bump version');

    const result = await analyze({
      mode: 'semantic_diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    expect(['low', 'medium', 'high']).toContain(result.risk as string);
  });

  test('changed_files lists modified files', async () => {
    addCommit(gitDir, 'mod.ts', 'export function x() {}', 'initial');
    addCommit(gitDir, 'mod.ts', 'export function x() { return 1; }', 'update');

    const result = await analyze({
      mode: 'semantic_diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    const files = result.changed_files as string[];
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes('mod.ts'))).toBe(true);
  });

  test('invalid ref returns error', async () => {
    const result = await analyzeMayFail({
      mode: 'semantic_diff',
      projectRoot: gitDir,
      before: 'HEAD; rm -rf /',
      after: 'HEAD',
    });

    if (result.success) {
      const parsed = JSON.parse(result.output!);
      expect(parsed).toHaveProperty('error');
    } else {
      expect(result.error).toBeDefined();
    }
  });

  test('before/after refs included in result', async () => {
    addCommit(gitDir, 'x.ts', 'export const A = 1;', 'v1');
    addCommit(gitDir, 'x.ts', 'export const A = 2;', 'v2');

    const result = await analyze({
      mode: 'semantic_diff',
      projectRoot: gitDir,
      before: 'HEAD~1',
      after: 'HEAD',
    });

    expect(result.before).toBe('HEAD~1');
    expect(result.after).toBe('HEAD');
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

// ---------------------------------------------------------------------------
// upgrade mode
// ---------------------------------------------------------------------------

describe('upgrade mode', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://registry.npmjs.org/typescript/latest') {
        return new Response(JSON.stringify({ version: '5.9.3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    fetchMock.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('reads packages from package.json when no packages specified', async () => {
    // package.json already has { name: 'analyze-test', version: '1.0.0' } — no deps
    const result = await analyze({
      mode: 'upgrade',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('packages');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('outdated');
    expect(result).toHaveProperty('breaking');
    // No deps in fixture package.json
    expect(result.total).toBe(0);
  });

  test('accepts explicit packages array', async () => {
    await writeTempFile(
      dir,
      'package.json',
      JSON.stringify({
        name: 'test',
        version: '1.0.0',
        dependencies: { typescript: '^5.0.0' },
      }),
    );

    const result = await analyze({
      mode: 'upgrade',
      projectRoot: dir,
      packages: ['typescript'],
    });

    expect(result).toHaveProperty('packages');
    const pkgs = result.packages as Array<{ name: string; current: string; latest: string; breaking: boolean }>;
    expect(pkgs.length).toBe(1);
    expect(pkgs[0].name).toBe('typescript');
    // current comes from package.json
    expect(pkgs[0].current).toBe('^5.0.0');
    // latest is either a version string or 'fetch_failed' (network may be unavailable in CI)
    expect(typeof pkgs[0].latest).toBe('string');
    expect(typeof pkgs[0].breaking).toBe('boolean');
  });

  test('returns error when no package.json and no packages', async () => {
    const tmpNoJson = await import('../setup.ts').then((m) => m.makeTempDir());
    try {
      const result = await analyze({
        mode: 'upgrade',
        projectRoot: tmpNoJson.dir,
      });
      expect(result).toHaveProperty('error');
    } finally {
      await tmpNoJson.cleanup();
    }
  });

  test('parseSemver: isBreakingUpgrade detects major bump', async () => {
    // Test via upgrade mode with a fake package in a controlled package.json
    await writeTempFile(
      dir,
      'package.json',
      JSON.stringify({
        name: 'test',
        version: '1.0.0',
        dependencies: { 'no-such-package-xyz-123456789': '1.0.0' },
      }),
    );

    const result = await analyze({
      mode: 'upgrade',
      projectRoot: dir,
      packages: ['no-such-package-xyz-123456789'],
    });

    const pkgs = result.packages as Array<{ name: string; latest: string }>;
    expect(pkgs.length).toBe(1);
    // Non-existent package should return fetch_failed or unknown
    expect(['fetch_failed', 'unknown']).toContain(pkgs[0].latest);
  });
});

// ---------------------------------------------------------------------------
// permissions mode
// ---------------------------------------------------------------------------

describe('permissions mode', () => {
  test('detects eval() usage', async () => {
    await writeTempFile(
      dir,
      'src/dangerous.ts',
      [
        'function run(code: string) {',
        '  return eval(code);',
        '}',
      ].join('\n'),
    );

    const result = await analyze({
      mode: 'permissions',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('findings');
    const findings = result.findings as Array<{ file: string; pattern: string; severity: string; line: number }>;
    const evalFindings = findings.filter((f) => f.pattern === 'eval');
    expect(evalFindings.length).toBeGreaterThan(0);
    expect(evalFindings[0].severity).toBe('high');
    expect(typeof evalFindings[0].line).toBe('number');
  });

  test('detects new Function() usage', async () => {
    await writeTempFile(
      dir,
      'src/func.ts',
      'const fn = new Function("return 1");',
    );

    const result = await analyze({
      mode: 'permissions',
      projectRoot: dir,
    });

    const findings = result.findings as Array<{ pattern: string }>;
    expect(findings.some((f) => f.pattern === 'new_Function')).toBe(true);
  });

  test('detects dangerouslySetInnerHTML', async () => {
    await writeTempFile(
      dir,
      'src/component.tsx',
      '<div dangerouslySetInnerHTML={{ __html: userInput }} />',
    );

    const result = await analyze({
      mode: 'permissions',
      projectRoot: dir,
    });

    const findings = result.findings as Array<{ pattern: string }>;
    expect(findings.some((f) => f.pattern === 'dangerouslySetInnerHTML')).toBe(true);
  });

  test('returns structured result with totals', async () => {
    const result = await analyze({
      mode: 'permissions',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('files_affected');
    expect(result).toHaveProperty('by_severity');
    const bySeverity = result.by_severity as { high: number; medium: number; low: number };
    expect(typeof bySeverity.high).toBe('number');
    expect(typeof bySeverity.medium).toBe('number');
    expect(typeof bySeverity.low).toBe('number');
  });

  test('returns empty findings for clean code', async () => {
    // The fixture files (index.ts, utils.ts, types.ts) have no dangerous patterns
    const result = await analyze({
      mode: 'permissions',
      files: ['src/types.ts'],
      projectRoot: dir,
    });

    const findings = result.findings as Array<unknown>;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// env_audit mode
// ---------------------------------------------------------------------------

describe('env_audit mode', () => {
  test('returns message when no .env files found', async () => {
    const result = await analyze({
      mode: 'env_audit',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('missing');
    expect(result).toHaveProperty('extra');
    // No .env files in fixture dir
    const files = result.files as unknown[];
    expect(files.length).toBe(0);
  });

  test('detects missing keys when .env has keys not in .env.local', async () => {
    await writeTempFile(dir, '.env', 'DB_URL=postgres://localhost/db\nAPI_KEY=abc\nSECRET=xyz');
    await writeTempFile(dir, '.env.local', 'DB_URL=postgres://localhost/localdb');

    const result = await analyze({
      mode: 'env_audit',
      projectRoot: dir,
    });

    expect(result).toHaveProperty('missing');
    const missing = result.missing as Array<{ key: string; missing_from: string[] }>;
    const missingKeys = missing.map((m) => m.key);
    // API_KEY and SECRET are in .env but not .env.local
    expect(missingKeys).toContain('API_KEY');
    expect(missingKeys).toContain('SECRET');
  });

  test('detects extra keys in .env.local not in .env', async () => {
    await writeTempFile(dir, '.env', 'DB_URL=postgres://localhost/db');
    await writeTempFile(dir, '.env.local', 'DB_URL=postgres://localhost/localdb\nEXTRA_KEY=foo');

    const result = await analyze({
      mode: 'env_audit',
      projectRoot: dir,
    });

    const extra = result.extra as Array<{ key: string; only_in: string }>;
    const extraKeys = extra.map((e) => e.key);
    expect(extraKeys).toContain('EXTRA_KEY');
  });

  test('uses .env.example as reference when present', async () => {
    await writeTempFile(dir, '.env.example', 'DB_URL=\nAPI_KEY=\nDEBUG=');
    await writeTempFile(dir, '.env', 'DB_URL=postgres://localhost/db\nAPI_KEY=abc');

    const result = await analyze({
      mode: 'env_audit',
      projectRoot: dir,
    });

    expect(result.reference).toBe('.env.example');
    const missing = result.missing as Array<{ key: string }>;
    // DEBUG is in .env.example but not in .env
    expect(missing.some((m) => m.key === 'DEBUG')).toBe(true);
  });

  test('returns key_count per file', async () => {
    await writeTempFile(dir, '.env', 'A=1\nB=2\nC=3');

    const result = await analyze({
      mode: 'env_audit',
      projectRoot: dir,
    });

    const files = result.files as Array<{ name: string; key_count: number }>;
    const envFile = files.find((f) => f.name === '.env');
    expect(envFile).toBeDefined();
    expect(envFile!.key_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// test_find mode
// ---------------------------------------------------------------------------

describe('test_find mode', () => {
  test('returns error when no files specified', async () => {
    const result = await analyze({
      mode: 'test_find',
      projectRoot: dir,
    });
    expect(result).toHaveProperty('error');
  });

  test('finds existing test file (src/test/ convention)', async () => {
    // The fixture dir has src/index.ts; create src/test/index.test.ts
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'src', 'test'), { recursive: true }));
    await writeTempFile(dir, 'src/test/index.test.ts', '// test');

    const result = await analyze({
      mode: 'test_find',
      files: ['src/index.ts'],
      projectRoot: dir,
    });

    const mappings = result.mappings as Array<{ source: string; test: string | null; exists: boolean }>;
    expect(mappings.length).toBe(1);
    expect(mappings[0].source).toBe('src/index.ts');
    expect(mappings[0].exists).toBe(true);
    expect(mappings[0].test).toContain('index');
  });

  test('returns exists: false when no test file found', async () => {
    const result = await analyze({
      mode: 'test_find',
      files: ['src/types.ts'],
      projectRoot: dir,
    });

    const mappings = result.mappings as Array<{ source: string; test: string | null; exists: boolean }>;
    expect(mappings.length).toBe(1);
    expect(mappings[0].exists).toBe(false);
    expect(mappings[0].test).toBeNull();
  });

  test('handles multiple source files', async () => {
    const result = await analyze({
      mode: 'test_find',
      files: ['src/index.ts', 'src/utils.ts', 'src/types.ts'],
      projectRoot: dir,
    });

    expect(result).toHaveProperty('mappings');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('found');
    expect(result).toHaveProperty('missing');
    const mappings = result.mappings as Array<{ source: string }>;
    expect(mappings.length).toBe(3);
    expect(result.total).toBe(3);
  });

  test('finds co-located .test.ts file', async () => {
    // Create src/utils.test.ts alongside src/utils.ts
    await writeTempFile(dir, 'src/utils.test.ts', '// tests for utils');

    const result = await analyze({
      mode: 'test_find',
      files: ['src/utils.ts'],
      projectRoot: dir,
    });

    const mappings = result.mappings as Array<{ source: string; test: string | null; exists: boolean }>;
    expect(mappings[0].exists).toBe(true);
    expect(mappings[0].test).toContain('utils.test.ts');
  });

  test('finds __tests__ directory convention', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'src', '__tests__'), { recursive: true }));
    await writeTempFile(dir, 'src/__tests__/types.test.ts', '// tests');

    const result = await analyze({
      mode: 'test_find',
      files: ['src/types.ts'],
      projectRoot: dir,
    });

    const mappings = result.mappings as Array<{ exists: boolean }>;
    expect(mappings[0].exists).toBe(true);
  });
});

describe('analyze output formatting', () => {
  test('summary output is materially smaller for dead_code mode', async () => {
    const detailed = await analyzeTool.execute({
      mode: 'dead_code',
      projectRoot: dir,
      output: { format: 'detailed' },
    });
    const summary = await analyzeTool.execute({
      mode: 'dead_code',
      projectRoot: dir,
      output: { format: 'summary' },
    });

    expect(detailed.success).toBe(true);
    expect(summary.success).toBe(true);
    expect((detailed.output ?? '').length).toBeGreaterThan((summary.output ?? '').length);

    const summaryData = JSON.parse(summary.output!) as Record<string, unknown>;
    expect(summaryData).toHaveProperty('dead_export_count');
    expect(summaryData).not.toHaveProperty('totalExportsByFile');
  });

  test('summary output for security mode preserves top findings but omits raw nested payloads', async () => {
    await writeTempFile(
      dir,
      'src/config.ts',
      "const apiKey = 'sk-aBcDeFgHiJkLmNoPqRsTuVwX';\nconst token = 'my-secret-token-value-here';\nexport { apiKey, token };",
    );

    const result = await analyze({
      mode: 'security',
      securityScope: 'all',
      projectRoot: dir,
      output: { format: 'summary' },
    });

    expect(result).toHaveProperty('secretFindingCount');
    expect(result).toHaveProperty('topSecretFindings');
    expect(result).not.toHaveProperty('secrets');
  });

  test('max_tokens truncates serialized analyze output', async () => {
    const result = await analyzeTool.execute({
      mode: 'surface',
      projectRoot: dir,
      files: ['src'],
      output: { format: 'json', max_tokens: 20 },
    });

    expect(result.success).toBe(true);
    expect(result.output!.length).toBeLessThanOrEqual(81);
    expect(result.output!.endsWith('…')).toBe(true);
  });
});
