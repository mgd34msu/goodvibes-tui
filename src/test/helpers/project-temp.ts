import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_TEST_TMP_ROOT = join(process.cwd(), '.test-tmp');

// Set of dirs created by this module in the current process.
// The exit hook walks this set and removes each one.
const _registeredDirs = new Set<string>();
let _exitHookRegistered = false;
let _gitCeilingSet = false;

/**
 * Fence git's upward repo discovery at `.test-tmp`, once per process.
 *
 * `.test-tmp` lives inside this project's own working tree, so a scratch
 * dir with no `.git` of its own (nothing else creates one) sits inside a
 * real git repository — this project's. Any code that shells out to
 * `git rev-parse --show-toplevel` (or similar discovery) from a
 * makeProjectTempDir path, expecting a plain non-repo directory, would
 * silently walk up and resolve to this project's own repo root instead.
 * That is not hypothetical: @pellux/goodvibes-sdk's WorkspaceCheckpointManager
 * does exactly this by default (`preferGitRoot`), and it changed which root a
 * `.test-tmp`-rooted test guard evaluated.
 *
 * GIT_CEILING_DIRECTORIES is a real git mechanism (colon-separated absolute
 * paths; discovery stops there). This mutation only reaches git subprocess
 * calls that build their own env from a *live* read of `process.env` at
 * call time (e.g. simple-git's `.env(process.env)`, or execSync given an
 * explicit `env` option) — confirmed empirically. It does NOT reach a raw
 * `Bun.spawnSync(['git', ...])` with no `env` option (e.g.
 * `GitService.isGitRepo`): Bun snapshots the environment at its own process
 * start, so a same-process mutation after that point is invisible to it —
 * also confirmed empirically. That gap is why `scripts/run-tests.ts` sets
 * this same variable in the *spawn* env of each per-file `bun test` child
 * (reaching the child's own startup snapshot, which every mechanism
 * respects) rather than relying on this function alone. Keep this as a
 * partial, defense-in-depth backstop for the live-env-reading mechanisms —
 * it is not a complete fix by itself. Appends to (never clobbers) any
 * ceiling already present.
 */
function ensureGitCeiling(root: string): void {
  if (_gitCeilingSet) return;
  _gitCeilingSet = true;
  const canonicalRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  const entries = existing ? existing.split(':') : [];
  if (!entries.includes(canonicalRoot)) entries.push(canonicalRoot);
  process.env.GIT_CEILING_DIRECTORIES = entries.join(':');
}

function ensureProjectTestTmpRoot(): string {
  if (!existsSync(PROJECT_TEST_TMP_ROOT)) {
    mkdirSync(PROJECT_TEST_TMP_ROOT, { recursive: true });
  }
  ensureGitCeiling(PROJECT_TEST_TMP_ROOT);
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
