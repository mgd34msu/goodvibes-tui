import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SweepOptions {
  /** Clock reference (injectable for tests). Defaults to Date.now(). */
  readonly now?: number;
  /** Entries older than this are removed. Defaults to 1 hour. */
  readonly staleMs?: number;
}

/** Default stale threshold: 1 hour. */
export const DEFAULT_STALE_MS = 60 * 60 * 1000;

/**
 * Remove stale entries under the shared `.test-tmp` root.
 *
 * This is the BACKSTOP for a signal-killed process, not the primary cleanup.
 * Two leak vectors reach it:
 *   1. `run-<pid>` runner subtrees — run-tests.ts removes its own in a
 *      `finally`, but a hard-killed runner (timeout/OOM) can leave one behind.
 *   2. `makeProjectTempDir` leftovers (`<prefix>-<random>`, see
 *      src/test/helpers/project-temp.ts) — normally removed by the `afterAll`
 *      in src/test/preload/temp-cleanup.ts when the test process finishes, so
 *      only a process that never reached its afterAll (SIGKILL, OOM) leaves one.
 *      Under these worktrees the project lives on /tmp, so each leaked subtree
 *      is a leaked /tmp inode subtree.
 *
 * That primary cleanup used to be a `process.on('exit')` hook, which `bun test`
 * never fires at all — so until it was replaced this sweep was reaping the
 * output of every ordinary green run, an hour late.
 *
 * Age-gated (default 1 h) so it is safe under concurrency: a live sibling
 * runner's `run-<pid>` dir and any in-flight `makeProjectTempDir` dir are at
 * most seconds old and are never touched; only orphans a crash/kill left behind
 * (necessarily older) are removed. Returns the names actually removed.
 */
export function sweepStaleTestTmp(root: string, options: SweepOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // root doesn't exist yet — nothing to sweep
  }

  const removed: string[] = [];
  for (const name of entries) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > staleMs) {
        rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // ignore — another concurrent runner may have already removed it
    }
  }
  return removed;
}
