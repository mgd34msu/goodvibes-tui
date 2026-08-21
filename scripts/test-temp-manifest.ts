/**
 * The handover between a finished test process and the runner that spawned it.
 *
 * A test process cleans up its own temp directories in an `afterAll`
 * (src/test/preload/temp-cleanup.ts). That is best-effort and cannot be made
 * exact: a few suites are still writing when their last test ends and recreate a
 * directory moments after it is deleted, and nothing running inside the process
 * can reliably outlast its own stragglers.
 *
 * So the process also writes the list of directories it owned to a manifest, and
 * scripts/run-tests.ts removes them once the child has EXITED. At that point no
 * writer is left to race. Only paths that child created are touched, which keeps
 * this safe while 8 test processes share <repo>/.test-tmp.
 *
 * Lives in scripts/ (not in the runner) because scripts/run-tests.ts runs the
 * whole suite the moment it is imported, so nothing can test its internals.
 */
import { readFileSync, rmSync } from 'node:fs';

/** Environment variable naming the manifest path for a child test process. */
export const TEST_TEMP_MANIFEST_ENV = 'GOODVIBES_TEST_TEMP_MANIFEST';

/**
 * Parse a manifest's contents into the directory list it names.
 *
 * Anything that is not a JSON array of non-empty strings yields an empty list:
 * a child killed before its teardown ran never wrote a manifest, and a truncated
 * one must not turn into a delete of some path a half-written string happens to
 * spell. The age-gated sweep in scripts/stale-tmp-sweep.ts is the backstop for
 * both cases.
 */
export function parseTempManifest(contents: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Remove every directory the manifest at `manifestPath` names, then the manifest
 * itself. Returns the paths it attempted to remove, empty when there was no
 * readable manifest.
 */
export function removeManifestedTempDirs(manifestPath: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(manifestPath, 'utf8');
  } catch {
    return [];
  }
  const dirs = parseTempManifest(contents);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left for the stale sweep rather than failing the run.
    }
  }
  rmSync(manifestPath, { force: true });
  return dirs;
}
