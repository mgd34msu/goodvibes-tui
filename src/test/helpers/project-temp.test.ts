/**
 * Tests for makeProjectTempDir helper — verifies temp dir is created and
 * a process-exit cleanup is registered.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Use the actual module so we exercise the real exit-hook registration path.
import { makeProjectTempDir, PROJECT_TEST_TMP_ROOT } from './project-temp.ts';

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

  test('exit-hook registration: dirs created in same process are cleaned up on exit', () => {
    // Spawn a child process that creates a temp dir via makeProjectTempDir and
    // exits normally. After it exits, the temp dir should not exist because
    // the exit hook removes it.
    const script = /* ts */ `
import { makeProjectTempDir } from '${join(import.meta.dir, 'project-temp.ts')}';
const dir = makeProjectTempDir('gv-exitclean');
// Write the path to stdout so the parent can check it after exit.
process.stdout.write(dir);
// Normal exit — triggers the registered 'exit' hook.
`;
    const result = Bun.spawnSync(['bun', '--eval', script], {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    const createdPath = result.stdout.toString().trim();
    expect(createdPath.length).toBeGreaterThan(0);
    // After the child process exited normally the hook should have removed it.
    expect(existsSync(createdPath)).toBe(false);
  });

  // Best-effort cleanup of any dirs that survived.
  // (The exit hook handles cleanup in production; this is belt-and-suspenders for the test runner.)
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
