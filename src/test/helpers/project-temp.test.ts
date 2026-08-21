// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
/**
 * Tests for the makeProjectTempDir helper, the directory it creates, where it
 * puts it, and that the directory is handed to the shared cleanup registry.
 *
 * That the registry is actually drained when a `bun test` process ends is
 * measured separately, by counting directories after a real child process
 * finishes, in helpers/temp-cleanup.test.ts.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeProjectTempDir, PROJECT_TEST_TMP_ROOT } from './project-temp.ts';
import { registeredTempDirs } from './temp-registry.ts';

describe('makeProjectTempDir', () => {
  // Track dirs created within this test suite so we can clean up regardless.
  const created: string[] = [];

  beforeEach(() => {
    // Ensure the root exists before each test (the module creates it lazily).
    mkdirSync(PROJECT_TEST_TMP_ROOT, { recursive: true });
  });

  test('creates a directory with the given prefix', () => {
    const dir = makeProjectTempDir('gv-test-hygiene-prefix');
    created.push(dir);

    expect(existsSync(dir)).toBe(true);
    const base = dir.split('/').at(-1) ?? '';
    expect(base.startsWith('gv-test-hygiene-prefix-')).toBe(true);
  });

  test('created directory lives under PROJECT_TEST_TMP_ROOT', () => {
    const dir = makeProjectTempDir('gv-test-hygiene-root');
    created.push(dir);

    expect(dir.startsWith(PROJECT_TEST_TMP_ROOT)).toBe(true);
  });

  test('each call produces a unique directory', () => {
    const a = makeProjectTempDir('gv-test-hygiene-unique');
    const b = makeProjectTempDir('gv-test-hygiene-unique');
    created.push(a, b);

    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test('a directory is registered for cleanup as soon as it is created', () => {
    const dir = makeProjectTempDir('gv-registered');
    created.push(dir);
    expect(registeredTempDirs()).toContain(dir);
  });

  // NOTE ON WHAT USED TO BE HERE. This slot held a test called "exit-hook
  // registration: dirs created in same process are cleaned up on exit". It
  // spawned `bun --eval`, which is `bun run` semantics, a runtime where
  // `process.on('exit')` DOES fire. `bun test`, the runtime the whole suite
  // actually uses, never fires exit handlers, so the test reported green while
  // the cleanup it described removed nothing on any real run. Cleanup under
  // `bun test` is now measured end to end by counting directories after a real
  // `bun test` child process finishes, in helpers/temp-cleanup.test.ts.

  // Belt and braces. The preload's afterAll removes these anyway; removing them
  // here too keeps the directories from sitting around for the rest of the file.
  afterAll(() => {
    for (const d of created) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// Also verify that PROJECT_TEST_TMP_ROOT is the canonical .test-tmp root.
describe('PROJECT_TEST_TMP_ROOT', () => {
  test('resolves to <cwd>/.test-tmp', () => {
    expect(PROJECT_TEST_TMP_ROOT).toBe(join(process.cwd(), '.test-tmp'));
  });

  test('.test-tmp directory exists after any makeProjectTempDir call', () => {
    makeProjectTempDir('gv-test-hygiene-root-check');
    expect(existsSync(PROJECT_TEST_TMP_ROOT)).toBe(true);
  });
});
