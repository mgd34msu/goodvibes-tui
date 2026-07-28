/**
 * bun test preload — temp-directory containment and teardown.
 *
 * Wired in bunfig.toml (`[test] preload`), so it loads once per test process,
 * before any test file, and applies to `bun test` however it is invoked: through
 * scripts/run-tests.ts, or bare on the command line.
 *
 * It does two things.
 *
 * 1. CONTAINMENT. It creates one directory per test process inside the inherited
 *    temp root and repoints process.env.TMPDIR/TMP/TEMP at it. `os.tmpdir()`
 *    reads those variables on every call (verified against this Bun build), so
 *    every in-process `mkdtempSync(join(tmpdir(), ...))` — the ~314 test files
 *    that build temp paths by hand included — now lands inside one directory
 *    this process owns and can delete wholesale. Nothing has to be fixed file by
 *    file, and nothing outside this process's own directory is ever touched.
 *
 * 2. TEARDOWN. A top-level `afterAll` drains the shared registry in
 *    helpers/temp-registry.ts — the per-process root above, plus every directory
 *    a helper registered explicitly (notably makeProjectTempDir, which writes
 *    under <repo>/.test-tmp and so does NOT follow TMPDIR). `afterAll` is used
 *    because `bun test` does not fire `process.on('exit')`; that is the defect
 *    this file exists to close, and a preload-level `afterAll` is the hook that
 *    was measured to actually run (and to run after each file's own afterAll).
 *
 * 3. HANDOVER. Teardown inside the process can only ever be best-effort, because
 *    a few suites are still writing when the last test ends and recreate a
 *    directory moments after it is deleted (measured: a handful of files out of
 *    314, and the survivor holds a tree written AFTER teardown). Nothing running
 *    inside the process can win that race for certain. So when
 *    GOODVIBES_TEST_TEMP_MANIFEST names a path, the teardown also writes the full
 *    list of directories it owned to that file. scripts/run-tests.ts sets it and
 *    deletes the listed paths once the child has EXITED — no writer is left to
 *    race, and only that child's own directories are touched, which keeps it safe
 *    with 8 test processes sharing <repo>/.test-tmp.
 *
 * KNOWN LIMIT, stated rather than papered over: Bun snapshots the environment at
 * process start for spawned children, so a child process started by a test still
 * sees the TMPDIR this process inherited, not the redirected one. Under
 * scripts/run-tests.ts that inherited value is already a per-file directory the
 * runner removes in a `finally`, so children are contained there. Under a bare
 * `bun test` with no manifest, a child writing to the system temp dir — and a
 * late writer that outlasts the drain budget — are outside this file's reach.
 */
import { afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTempDirsUntilSettled, registerTempDirForCleanup } from '../helpers/temp-registry.ts';
import { TEST_TEMP_MANIFEST_ENV } from '../../../scripts/test-temp-manifest.ts';

/** The temp root this process inherited, before the redirect below. */
export const INHERITED_TMP_ROOT = tmpdir();

mkdirSync(INHERITED_TMP_ROOT, { recursive: true });

/** This process's private temp root; removed in full when the process ends. */
export const PROCESS_TMP_ROOT = mkdtempSync(
  join(INHERITED_TMP_ROOT, `gv-test-proc-${String(process.pid)}-`),
);

process.env.TMPDIR = PROCESS_TMP_ROOT;
process.env.TMP = PROCESS_TMP_ROOT;
process.env.TEMP = PROCESS_TMP_ROOT;

registerTempDirForCleanup(PROCESS_TMP_ROOT);

afterAll(async () => {
  // Drains, then re-checks: a handful of suites are still writing when the last
  // test ends and recreate the directory the first pass removed. Set
  // GOODVIBES_TEST_TEMP_LEAK_REPORT=1 to have a process that could not close a
  // leak say so on stderr instead of exiting quietly.
  const result = await drainTempDirsUntilSettled();
  if (result.survivors.length > 0 && process.env.GOODVIBES_TEST_TEMP_LEAK_REPORT) {
    console.error(
      `temp-cleanup: ${result.survivors.length} directory/directories survived ${result.passes} pass(es): ${result.survivors.join(', ')}`,
    );
  }

  // Hand the full list to whoever launched this process, so it can finish the
  // job once nothing here is running. Every path is included, not just the
  // survivors: a directory recreated after this hook returns would not be in the
  // survivor list yet, and that is exactly the case the handover exists for.
  const manifestPath = process.env[TEST_TEMP_MANIFEST_ENV];
  if (manifestPath) {
    const owned = [...result.removed, ...result.survivors];
    try {
      writeFileSync(manifestPath, JSON.stringify(owned), 'utf8');
    } catch {
      // The runner treats a missing manifest as "nothing extra to remove"; its
      // own per-file TMPDIR removal is unaffected.
    }
  }
});
