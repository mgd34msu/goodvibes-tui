/**
 * Gate test for scripts/typecheck-coverage-rule.ts.
 *
 * Two jobs, and the second matters as much as the first:
 *   1. the repo is currently clean — every tracked TypeScript file is compiled
 *      by tsconfig.json or tsconfig.test.json;
 *   2. the check can still answer NO. A coverage detector that returns "all
 *      covered" unconditionally passes forever and hides exactly the defect it
 *      was written for, so these tests feed it a file that really exists on disk
 *      and really is in no project, and require it to be reported.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKED_PROJECTS,
  REPO_ROOT,
  findUncoveredFiles,
  isTypeScriptPath,
  listCoveredFiles,
  listProjectFiles,
  listTrackedTypeScriptFiles,
} from '../../../scripts/typecheck-coverage-rule.ts';

/**
 * A real file, in the repo root, matching none of the `include` globs. Written
 * for the negative case and removed again; the name is dot-prefixed so a crashed
 * run leaves something obviously disposable rather than a plausible source file.
 */
const PROBE_REL = '.typecheck-coverage-probe.ts';
const PROBE_ABS = join(REPO_ROOT, PROBE_REL);

function removeProbe(): void {
  if (existsSync(PROBE_ABS)) rmSync(PROBE_ABS, { force: true });
}

afterAll(removeProbe);

/**
 * Each listProjectFiles call spawns tsc (~1.5 s), so the assertions that only
 * read the settled repo share one resolved list per project. The probe test
 * deliberately does NOT use this cache — it needs tsc to run with the probe file
 * present on disk.
 */
const projectFileCache = new Map<string, Set<string>>();
function cachedProjectFiles(project: string): Set<string> {
  const hit = projectFileCache.get(project);
  if (hit) return hit;
  const files = listProjectFiles(project);
  projectFileCache.set(project, files);
  return files;
}

describe('isTypeScriptPath', () => {
  test('accepts the four TypeScript extensions', () => {
    expect(isTypeScriptPath('scripts/run-tests.ts')).toBe(true);
    expect(isTypeScriptPath('src/app.tsx')).toBe(true);
    expect(isTypeScriptPath('scripts/x.mts')).toBe(true);
    expect(isTypeScriptPath('scripts/x.cts')).toBe(true);
  });

  test('rejects non-TypeScript paths', () => {
    expect(isTypeScriptPath('scripts/postinstall.js')).toBe(false);
    expect(isTypeScriptPath('README.md')).toBe(false);
    expect(isTypeScriptPath('tsconfig.json')).toBe(false);
  });
});

describe('findUncoveredFiles', () => {
  test('reports a tracked file that is in no project', () => {
    const uncovered = findUncoveredFiles(
      ['src/main.ts', 'scripts/orphan.ts'],
      new Set(['src/main.ts']),
      new Set<string>(),
    );
    expect(uncovered).toEqual(['scripts/orphan.ts']);
  });

  test('reports nothing when every tracked file is covered', () => {
    const uncovered = findUncoveredFiles(
      ['src/main.ts', 'scripts/orphan.ts'],
      new Set(['src/main.ts', 'scripts/orphan.ts']),
      new Set<string>(),
    );
    expect(uncovered).toEqual([]);
  });

  test('honours the allowlist, and only for the listed path', () => {
    const uncovered = findUncoveredFiles(
      ['scripts/allowed.ts', 'scripts/orphan.ts'],
      new Set<string>(),
      new Set(['scripts/allowed.ts']),
    );
    expect(uncovered).toEqual(['scripts/orphan.ts']);
  });
});

describe('listProjectFiles', () => {
  test('resolves the real file list of each checked project', () => {
    for (const project of CHECKED_PROJECTS) {
      const files = cachedProjectFiles(project);
      expect(files.size).toBeGreaterThan(100);
      expect(files.has('src/main.ts')).toBe(true);
      // node_modules dependencies are compiled but are not repo sources.
      for (const f of files) expect(f.includes('node_modules/')).toBe(false);
    }
  });

  test('tsconfig.json compiles scripts/, tsconfig.test.json compiles src/test/', () => {
    const main = cachedProjectFiles('tsconfig.json');
    const tests = cachedProjectFiles('tsconfig.test.json');
    expect(main.has('scripts/run-tests.ts')).toBe(true);
    expect(tests.has('src/test/scripts/typecheck-coverage.test.ts')).toBe(true);
    // The negative half: tsconfig.json excludes src/test, so this very file is
    // absent from it. If that ever reads true, the assertions above stopped
    // distinguishing the two projects.
    expect(main.has('src/test/scripts/typecheck-coverage.test.ts')).toBe(false);
  });
});

describe('typecheck coverage of the repo', () => {
  test('every tracked TypeScript file is compiled by a checked project', () => {
    const tracked = listTrackedTypeScriptFiles();
    expect(tracked.length).toBeGreaterThan(1000);
    const covered = listCoveredFiles();
    expect(findUncoveredFiles(tracked, covered)).toEqual([]);
  });

  test('a real file outside every include glob is reported as uncovered', () => {
    // Proof the detector can answer NO end to end: a file that exists on disk,
    // in the repo, matching no `include` glob, must survive the set difference
    // against the file list tsc actually resolves.
    try {
      writeFileSync(PROBE_ABS, 'export const probe = 1;\n', 'utf8');
      const covered = listCoveredFiles();
      expect(covered.has(PROBE_REL)).toBe(false);
      expect(findUncoveredFiles([PROBE_REL, 'src/main.ts'], covered, new Set<string>())).toEqual([
        PROBE_REL,
      ]);
      // ...and the same call still clears a file that IS covered, so the NO above
      // is discrimination rather than a blanket "uncovered".
      expect(findUncoveredFiles(['src/main.ts'], covered, new Set<string>())).toEqual([]);
    } finally {
      removeProbe();
    }
  });
});
