// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
/**
 * Tests for the temp-directory teardown: helpers/temp-registry.ts and the
 * preload that drains it (src/test/preload/temp-cleanup.ts).
 *
 * These COUNT DIRECTORIES after a real `bun test` child process finishes. They
 * do not inspect the hook, because inspecting the hook is exactly what let the
 * previous cleanup ship broken: it was a `process.on('exit')` handler, `bun test`
 * never fires those, and the old test "proving" it worked ran the code under
 * `bun --eval` — `bun run` semantics, where exit handlers DO fire. It passed for
 * years while every green run leaked.
 *
 * Every positive assertion below is paired with a negative one that makes the
 * same measurement report a leak, so "0 left behind" is a result the harness
 * could have failed to produce.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createTempDirRegistry, drainTempDirsUntilSettled } from './temp-registry.ts';
import { makeProjectTempDir } from './project-temp.ts';

/** Repo root — this file is src/test/helpers/, so three levels up. */
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

/**
 * One root under <repo>/.test-tmp for every directory this file creates.
 *
 * Not `tmpdir()`: this file is the test for the mechanism that stops scratch
 * from landing in the real OS temp dir, so it is the last file that should put
 * scratch there itself. The fixture SOURCES below still call `tmpdir()` on
 * purpose — that is the behaviour under test, and inside the spawned child the
 * preload has already repointed it at a contained root.
 *
 * The registry cases below build their own registries and must not add entries
 * to the process-wide one; only this single root is registered, so that holds.
 */
const FILE_TEMP_ROOT = makeProjectTempDir('gv-temp-cleanup-spec-root');

/** A directory under this file's own root, named like the old tmpdir() calls. */
function specDir(prefix: string): string {
  return mkdtempSync(join(FILE_TEMP_ROOT, `${prefix}-`));
}

/** Scratch space for the fixtures these tests spawn. Removed after each test. */
let scratch: string | null = null;

function makeScratch(): string {
  scratch = specDir('gv-temp-cleanup-spec');
  return scratch;
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/**
 * Run one generated test file in its own `bun test` process, from the repo root
 * so bunfig.toml (and therefore the preload) applies exactly as it does for the
 * real suite.
 */
function runFixture(
  fixturePath: string,
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'test', fixturePath], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function writeFixture(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

// Each case builds its OWN registry via createTempDirRegistry(). Draining the
// process-wide one here would empty it before the preload's afterAll ran, and
// this file's own temp directories would then leak — the very defect under test.
describe('temp-registry', () => {
  test('cleanup removes what was registered and reports it', () => {
    const registry = createTempDirRegistry();
    const dir = specDir('gv-registry-unit');
    registry.register(dir);
    expect(registry.entries()).toContain(dir);
    expect(existsSync(dir)).toBe(true);

    const removed = registry.cleanup();

    expect(removed).toContain(dir);
    expect(existsSync(dir)).toBe(false);
    expect(registry.entries()).not.toContain(dir);
  });

  test('an unregistered directory survives cleanup', () => {
    // The negative half: cleanup deletes the registry's contents, not "every
    // temp directory it can see". If this ever came back false the removal in
    // the previous test would prove nothing about registration.
    const registry = createTempDirRegistry();
    const kept = specDir('gv-registry-keep');
    const dropped = specDir('gv-registry-drop');
    registry.register(kept);
    registry.register(dropped);
    registry.unregister(kept);

    const removed = registry.cleanup();

    expect(removed).toContain(dropped);
    expect(removed).not.toContain(kept);
    expect(existsSync(dropped)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    rmSync(kept, { recursive: true, force: true });
  });

  test('cleanup of an already-deleted directory does not throw', () => {
    const registry = createTempDirRegistry();
    const dir = specDir('gv-registry-gone');
    registry.register(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(() => registry.cleanup()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The settle loop
// ---------------------------------------------------------------------------

describe('drainTempDirsUntilSettled', () => {
  test('stops after one pass when nothing comes back', async () => {
    const registry = createTempDirRegistry();
    const dir = registry.register(specDir('gv-drain-clean'));
    const waits: number[] = [];

    const result = await drainTempDirsUntilSettled({
      registry,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(result.survivors).toEqual([]);
    expect(result.removed).toContain(dir);
    // One drain, one confirming re-check, then done.
    expect(result.passes).toBe(1);
    expect(waits.length).toBe(1);
  });

  test('keeps going while a directory is recreated behind it', async () => {
    // The whole reason the loop exists. Without the extra passes the count this
    // suite reports would be "removed" while the directory was back on disk —
    // which is what a single-pass drain measured on 4 of 314 real test files.
    const registry = createTempDirRegistry();
    const dir = registry.register(specDir('gv-drain-flapping'));
    let recreations = 0;

    const result = await drainTempDirsUntilSettled({
      registry,
      backoffMs: [1, 1, 1, 1],
      sleep: async () => {
        // Stand in for a poller still writing after teardown: put the directory
        // back twice, then stop.
        if (recreations < 2) {
          mkdirSync(dir, { recursive: true });
          recreations += 1;
        }
      },
    });

    expect(recreations).toBe(2);
    expect(result.passes).toBeGreaterThan(1);
    expect(result.survivors).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test('reports a directory it could not clear rather than claiming success', async () => {
    // A writer that never stops: the drain must exhaust its budget and hand back
    // a survivor. A drain that always returns an empty survivor list would let a
    // permanent leak read as clean.
    const registry = createTempDirRegistry();
    const dir = registry.register(specDir('gv-drain-stuck'));

    const result = await drainTempDirsUntilSettled({
      registry,
      backoffMs: [1, 1, 1],
      sleep: async () => {
        mkdirSync(dir, { recursive: true });
      },
    });

    expect(result.survivors).toEqual([dir]);
    expect(result.removed).not.toContain(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// End to end, by counting what a finished `bun test` process left behind
// ---------------------------------------------------------------------------

describe('a finished bun test process leaves no temp directories', () => {
  test('makeProjectTempDir directories are gone after the process ends', () => {
    const dir = makeScratch();
    const fixture = writeFixture(
      dir,
      'project-temp-cleanup.test.ts',
      `import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { makeProjectTempDir } from ${JSON.stringify(join(REPO_ROOT, 'src/test/helpers/project-temp.ts'))};
const created = makeProjectTempDir('gv-cleanup-probe');
test('the directory exists while the test runs', () => {
  expect(existsSync(created)).toBe(true);
  console.log('CREATED=' + created);
});
`,
    );

    const res = runFixture(fixture);
    expect(res.exitCode).toBe(0);
    const created = /CREATED=(.+)/.exec(res.stdout)?.[1]?.trim();
    expect(created).toBeTruthy();
    // It existed during the run (asserted inside the fixture) and is gone now.
    expect(existsSync(created!)).toBe(false);
  });

  test('a directory created WITHOUT registering survives — the measurement can fail', () => {
    // Proof the assertion above is not vacuous: the same spawn-and-count harness,
    // pointed at a fixture that skips registration, reports the directory still
    // present. If this ever started passing "cleaned", the positive test would
    // be measuring nothing.
    const dir = makeScratch();
    const fixture = writeFixture(
      dir,
      'unregistered-leak.test.ts',
      `import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
const root = join(process.cwd(), '.test-tmp');
mkdirSync(root, { recursive: true });
const created = mkdtempSync(join(root, 'gv-unregistered-probe-'));
test('creates a directory nothing tracks', () => {
  expect(created.length).toBeGreaterThan(0);
  console.log('CREATED=' + created);
});
`,
    );

    const res = runFixture(fixture);
    expect(res.exitCode).toBe(0);
    const created = /CREATED=(.+)/.exec(res.stdout)?.[1]?.trim();
    expect(created).toBeTruthy();
    expect(existsSync(created!)).toBe(true);
    rmSync(created!, { recursive: true, force: true });
  });

  test('an isolated TMPDIR is empty after the process ends, and was not empty during it', () => {
    const dir = makeScratch();
    const isolatedTmp = join(dir, 'isolated-tmp');
    mkdirSync(isolatedTmp, { recursive: true });
    const report = join(dir, 'during.json');

    const fixture = writeFixture(
      dir,
      'tmpdir-containment.test.ts',
      `import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const isolated = ${JSON.stringify(isolatedTmp)};
test('creates temp dirs the ordinary way', () => {
  const a = mkdtempSync(join(tmpdir(), 'gv-contained-a-'));
  const b = mkdtempSync(join(tmpdir(), 'gv-contained-b-'));
  expect(a).not.toBe(b);
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({
    duringCount: readdirSync(isolated).length,
    tmpdirDuring: tmpdir(),
  }));
});
`,
    );

    const res = runFixture(fixture, { TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp });
    expect(res.exitCode).toBe(0);

    const during = JSON.parse(readFileSync(report, 'utf8')) as {
      duringCount: number;
      tmpdirDuring: string;
    };
    // The negative half again: the count this test asserts is zero afterwards was
    // demonstrably non-zero while the process was alive, so "0" is a real result
    // and not an empty directory that was never written to.
    expect(during.duringCount).toBeGreaterThan(0);
    // And the preload really did repoint tmpdir() inside the isolated root.
    expect(during.tmpdirDuring.startsWith(isolatedTmp)).toBe(true);
    expect(during.tmpdirDuring).not.toBe(isolatedTmp);

    expect(readdirSync(isolatedTmp)).toEqual([]);
  });
});
