import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'bun:test';

export const PROJECT_TEST_TMP_ROOT = join(process.cwd(), '.test-tmp');

// Set of dirs created by this module in the current process.
// The cleanup hooks below walk this set and remove each one.
const _registeredDirs = new Set<string>();
let _gitCeilingSet = false;

function _cleanupRegisteredDirs(): void {
  for (const dir of _registeredDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  _registeredDirs.clear();
}

// Registered at true module top level (evaluated once, the moment this
// module is first imported) — NOT lazily from inside makeProjectTempDir.
//
// Primary mechanism is `afterAll` (bun:test), not `process.on('exit', ...)`:
// confirmed empirically that Bun's test runner never fires
// `process.on('exit')` handlers under `bun test` (a marker-file exit
// handler in a `.test.ts` file never wrote its marker; the identical
// handler in a plain `bun run script.ts` did). That is why `.test-tmp`
// accumulated real, non-zero residue even on fully green, unkilled suite
// runs — not just killed ones. `afterAll`, by contrast, is reliably driven
// by the test runner — but only when registered during the collection
// phase; calling it lazily from inside an already-running test/beforeEach
// body (the previous exit-hook's pattern) does not reliably attach it,
// which is why this call sits at the top of the file instead of behind a
// lazy first-call guard.
//
// `afterAll()` throws ("Cannot use afterAll() outside of the test runner")
// when this module is imported from a plain script rather than an actual
// `bun test` run — a real, already-tested use case (see
// project-temp.test.ts's "exit-hook registration" test, which spawns a
// bare `bun --eval` script that imports this module directly). The
// try/catch below detects that and falls back to `process.on('exit')`,
// which fires correctly in that non-test context — confirmed empirically
// both ways.
//
// Known scope limit even in the `afterAll` branch: this module is cached
// (standard ESM import semantics), so its top-level code runs once per
// process. Under `bun run test` (scripts/run-tests.ts spawns one bun
// process PER test file) that means a fresh module instance — and a
// correctly-scoped `afterAll` — every time, so every file gets real
// cleanup. Under a whole-suite single-process invocation
// (`bun test --coverage src`, what `bun run test:coverage` /
// scripts/coverage-gate.ts spawns), only whichever file happens to trigger
// this module's first evaluation gets a working hook; every other file's
// directories are left for the age-gated `.test-tmp` sweep. Fixing that
// completely would mean not relying on a shared module's own top-level
// afterAll at all (registering one per consuming file instead) — out of
// scope here since `.test-tmp` lives on this project's own filesystem, not
// the OS temp dir that actually exhausted a host's tmpfs inodes.
try {
  afterAll(() => {
    _cleanupRegisteredDirs();
  });
} catch {
  process.on('exit', _cleanupRegisteredDirs);
}

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

/**
 * Create a temporary directory under `.test-tmp/<prefix>-<random>`.
 *
 * The directory is automatically removed once the current test file's
 * suite finishes (via the module-top-level `afterAll` above). Callers do
 * NOT need to wire a manual cleanup, though doing so is harmless and, for
 * a whole-suite single-process invocation (see the afterAll comment's
 * "known scope limit"), still worth keeping as a per-file belt-and-braces.
 */
export function makeProjectTempDir(prefix: string): string {
  const dir = mkdtempSync(join(ensureProjectTestTmpRoot(), `${prefix}-`));
  _registeredDirs.add(dir);
  return dir;
}
