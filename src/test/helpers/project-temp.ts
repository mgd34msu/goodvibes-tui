import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { registerTempDirForCleanup } from './temp-registry.ts';

export const PROJECT_TEST_TMP_ROOT = join(process.cwd(), '.test-tmp');

function ensureProjectTestTmpRoot(): string {
  if (!existsSync(PROJECT_TEST_TMP_ROOT)) {
    mkdirSync(PROJECT_TEST_TMP_ROOT, { recursive: true });
  }
  return PROJECT_TEST_TMP_ROOT;
}

/**
 * Create a temporary directory under `.test-tmp/<prefix>-<random>`.
 *
 * The directory is removed when the test process finishes, by the `afterAll`
 * that src/test/preload/temp-cleanup.ts registers. It is NOT removed by a
 * `process.on('exit')` hook — this helper used to register one, and `bun test`
 * never fires exit handlers, so every directory it handed out survived a green
 * run (98 of them across a 314-file run) until the age-gated sweep in
 * scripts/stale-tmp-sweep.ts reaped them an hour later.
 *
 * Note this root is derived from `process.cwd()`, not from TMPDIR, so these
 * directories deliberately do not follow the preload's TMPDIR redirect and are
 * cleaned by explicit registration instead.
 *
 * Callers do NOT need to wire a manual cleanup, though doing so is harmless.
 */
export function makeProjectTempDir(prefix: string): string {
  return registerTempDirForCleanup(
    mkdtempSync(join(ensureProjectTestTmpRoot(), `${prefix}-`)),
  );
}
