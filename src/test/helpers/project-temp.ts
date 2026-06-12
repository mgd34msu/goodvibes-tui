import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_TEST_TMP_ROOT = join(process.cwd(), '.test-tmp');

// Set of dirs created by this module in the current process.
// The exit hook walks this set and removes each one.
const _registeredDirs = new Set<string>();
let _exitHookRegistered = false;

function ensureProjectTestTmpRoot(): string {
  if (!existsSync(PROJECT_TEST_TMP_ROOT)) {
    mkdirSync(PROJECT_TEST_TMP_ROOT, { recursive: true });
  }
  return PROJECT_TEST_TMP_ROOT;
}

function ensureExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  process.on('exit', () => {
    for (const dir of _registeredDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });
}

/**
 * Create a temporary directory under `.test-tmp/<prefix>-<random>`.
 *
 * The directory is automatically removed when the current process exits
 * (via a registered `process.on('exit')` hook). Callers do NOT need to
 * wire a manual cleanup, though doing so is harmless.
 */
export function makeProjectTempDir(prefix: string): string {
  ensureExitHook();
  const dir = mkdtempSync(join(ensureProjectTestTmpRoot(), `${prefix}-`));
  _registeredDirs.add(dir);
  return dir;
}
