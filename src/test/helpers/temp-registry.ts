// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
/**
 * Registry of temporary directories the current test process must delete before
 * it ends, plus the routine that deletes them.
 *
 * WHY THIS EXISTS INSTEAD OF `process.on('exit')`
 * `bun test` never fires exit handlers. Measured, not assumed: a
 * `process.on('exit')` callback registered from a test file does not run when
 * `bun test` finishes, while the same callback does run under `bun run`. Every
 * cleanup this repo hung off that hook was therefore dead code on ordinary GREEN
 * runs, not only on killed ones, a fully green 314-file run left 1120
 * directories behind in TMPDIR and 98 under <repo>/.test-tmp.
 *
 * The hook that does fire is a top-level `afterAll` registered in a bun test
 * preload (src/test/preload/temp-cleanup.ts, wired through bunfig.toml). It
 * drains this registry, and it runs after the test file's own afterAll hooks,
 * so a test that cleans up for itself still goes first.
 *
 * Registration is EXPLICIT, never "delete whatever appeared in the temp root
 * while I was running". scripts/run-tests.ts runs up to 8 test processes at
 * once against the same <repo>/.test-tmp, so a diff-based sweep would delete a
 * live sibling's directories mid-run.
 */
import { existsSync, rmSync } from 'node:fs';

export interface TempDirRegistry {
  /**
   * Mark `dir` for removal when this registry is drained. Returns `dir` so it
   * can wrap a creation call: `register(mkdtempSync(...))`.
   *
   * Registering the same directory twice is harmless; removal is idempotent.
   */
  register(dir: string): string;
  /** Stop tracking `dir`, for a caller that has already removed it itself. */
  unregister(dir: string): void;
  /** Directories currently awaiting cleanup, in registration order. */
  entries(): readonly string[];
  /**
   * Remove every registered directory and empty the registry. Returns the paths
   * it removed, so a caller (and this module's own test) can assert it actually
   * did work rather than silently no-op.
   *
   * Individual failures are swallowed: a directory a test already deleted, or
   * one a still-running child process holds open, must not fail the run.
   */
  cleanup(): string[];
}

/**
 * Build an independent registry. The process-wide default below is the one the
 * preload drains; tests that need to exercise drain behaviour make their own so
 * they never empty the real one out from under the preload.
 */
export function createTempDirRegistry(): TempDirRegistry {
  const registered = new Set<string>();
  return {
    register(dir: string): string {
      registered.add(dir);
      return dir;
    },
    unregister(dir: string): void {
      registered.delete(dir);
    },
    entries(): readonly string[] {
      return [...registered];
    },
    cleanup(): string[] {
      const dirs = [...registered];
      registered.clear();
      const removed: string[] = [];
      for (const dir of dirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        } catch {
          // A concurrent holder or a permission problem, never fail the test
          // run over cleanup. The age-gated sweep in scripts/stale-tmp-sweep.ts
          // is the backstop for anything that survives.
        }
      }
      return removed;
    },
  };
}

/** The registry the preload drains at the end of every test process. */
const processRegistry = createTempDirRegistry();

/** Mark `dir` for removal when this test process finishes; returns `dir`. */
export function registerTempDirForCleanup(dir: string): string {
  return processRegistry.register(dir);
}

/** Stop tracking `dir` in the process-wide registry. */
export function unregisterTempDir(dir: string): void {
  processRegistry.unregister(dir);
}

/** Directories the process-wide registry will remove. */
export function registeredTempDirs(): readonly string[] {
  return processRegistry.entries();
}

/**
 * Drain the process-wide registry once. Called from
 * {@link drainTempDirsUntilSettled}; nothing else should call it, because
 * emptying the registry early would leave everything registered afterwards
 * uncleaned.
 */
export function cleanupRegisteredTempDirs(): string[] {
  return processRegistry.cleanup();
}

/**
 * Pause before each re-check, in ms. Backed off rather than fixed: nearly every
 * test file is settled by the first 10 ms pause and pays only that, while a file
 * whose daemon is still flushing gets up to ~0.8 s before the drain gives up.
 * A flat budget large enough for the slow files would have charged it to all 862.
 */
export const DEFAULT_DRAIN_BACKOFF_MS: readonly number[] = [10, 25, 50, 100, 200, 400];

export interface DrainOptions {
  /** Pause schedule; one re-check per entry. Defaults to DEFAULT_DRAIN_BACKOFF_MS. */
  readonly backoffMs?: readonly number[];
  /** Injected for tests, so they never actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Registry to drain. Defaults to the process-wide one the preload owns.
   * This module's own tests pass their own so they never empty the real
   * registry mid-run, doing that would delete the per-process temp root while
   * later tests were still using it.
   */
  readonly registry?: TempDirRegistry;
}

export interface DrainResult {
  /** Directories that are gone by the time the drain returns. */
  readonly removed: string[];
  /** Directories still present, a leak this process could not close. */
  readonly survivors: string[];
  /** Passes actually made, including the first. */
  readonly passes: number;
}

/**
 * Drain the registry, then keep checking that it stayed drained.
 *
 * One pass is not enough. Some suites still have work in flight when the last
 * test ends, a daemon flushing, a poller mid-write, and that work RECREATES
 * the directory the first pass just deleted. Measured on this repo: 4 of 314
 * test files did exactly that, and the leftover directory contained a full tree
 * written after teardown, not a stale one that survived it.
 *
 * The loop stops as soon as a pass finds nothing left, so a file with no
 * lingering work pays one short pause and nothing more. `survivors` is returned
 * rather than swallowed: a caller that wants to fail on a leak can, and the
 * count is the thing worth reporting.
 */
export async function drainTempDirsUntilSettled(options: DrainOptions = {}): Promise<DrainResult> {
  const backoffMs = options.backoffMs ?? DEFAULT_DRAIN_BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const registry = options.registry ?? processRegistry;

  const tracked = new Set<string>();
  let passes = 0;

  const pass = (): void => {
    passes += 1;
    for (const dir of registry.entries()) tracked.add(dir);
    registry.cleanup();
    for (const dir of tracked) {
      if (!existsSync(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Reported through `survivors` below rather than thrown.
      }
    }
  };

  pass();
  let settled = false;
  for (const delay of backoffMs) {
    await sleep(delay);
    // Check BEFORE removing again. Checking after a removal would always find
    // the directories gone and break on the first re-check, which is the same
    // as not having a loop at all.
    const dirtyAgain =
      registry.entries().length > 0 || [...tracked].some((dir) => existsSync(dir));
    if (!dirtyAgain) {
      settled = true;
      break;
    }
    pass();
  }
  if (!settled) {
    // The budget ran out with the last action being a removal, so the state right
    // now would read clean no matter what. Take one more look WITHOUT removing,
    // so a writer that never stops is reported instead of being papered over by
    // the timing of the final delete.
    await sleep(backoffMs.at(-1) ?? 0);
  }

  const survivors = [...tracked].filter((dir) => existsSync(dir));
  return {
    removed: [...tracked].filter((dir) => !existsSync(dir)),
    survivors,
    passes,
  };
}
