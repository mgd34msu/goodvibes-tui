// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
/**
 * Automatic teardown for anything a test starts.
 *
 * A test that builds a runtime graph, scheduler, manager, watcher or listener
 * and never disposes it leaves that object's `setInterval` / `setTimeout` chain
 * running. `createRuntimeServices()` alone starts a dozen of them, the fleet
 * registry tick, the config-file watch, the memory governor, the knowledge
 * scheduler, the cross-session orchestration sweep, the orchestration snapshot
 * writer, the push-subscription sweep and the snapshot / retention /
 * consolidation schedulers.
 *
 * This repo's runner (`scripts/run-tests.ts`) gives every test file its own
 * process, so a poller left behind cannot reach an unrelated later file the way
 * it does in the single-process SDK suite. What it does instead is burn the
 * rest of the file's runtime on work nobody is waiting for, hold the temp dirs
 * and SQLite handles those pollers write through, and make the file slower and
 * noisier than the behaviour it is testing. `scripts/leak-scan.ts` collapses
 * the suite into one process precisely so this is measurable at all.
 *
 * Usage, call `trackDisposables()` ONCE at the top level of a test file:
 *
 *   const disposables = trackDisposables();
 *
 *   test('...', () => {
 *     const services = disposables.add(createRuntimeServices({ ... }));
 *     // ...no teardown to write; it is disposed after this test.
 *   });
 *
 * `add()` returns its argument, so it wraps a constructor call in place.
 *
 * IMPORTANT, why this is a function you must call, and not an import side
 * effect: `bun test` caches modules, so a helper that registered `afterEach` at
 * import time would bind that hook ONLY to the first file that imported it.
 * Every later file would import the cached module, register nothing, and
 * silently get no cleanup. Calling `trackDisposables()` during each file's own
 * evaluation registers the hook in that file's scope, which is the only
 * reliable way to do this under a shared module cache.
 *
 * Kept deliberately identical to the SDK's `test/_helpers/disposables.ts`, so
 * the two suites cannot drift into different ideas of what tracked teardown
 * means.
 */
import { afterAll, afterEach } from 'bun:test';

type MaybePromise<T> = T | Promise<T>;
type Disposer = () => MaybePromise<void>;

export interface DisposableRegistry {
  /**
   * Register a value for automatic disposal and return it unchanged.
   *
   * With no explicit disposer, the first method the value actually has out of
   * `dispose`, `stop`, `close`, `destroy`, `shutdown` is used. A value with
   * none of those and no explicit disposer is rejected loudly rather than
   * silently leaking.
   */
  add<T>(value: T, disposer?: (value: T) => MaybePromise<void>): T;
  /** Register a bare cleanup callback (unsubscribe functions, temp dirs). */
  defer(fn: Disposer): void;
  /** Dispose everything registered so far. Runs automatically; idempotent. */
  flush(): Promise<void>;
  /** Outstanding registrations, used by this helper's own guard test. */
  readonly size: number;
}

/** Checked in order; the first one the value actually has wins. */
const DISPOSE_METHODS = ['dispose', 'stop', 'close', 'destroy', 'shutdown'] as const;

function hasMethod(value: object, name: string): boolean {
  return typeof (value as Record<string, unknown>)[name] === 'function';
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name ?? 'object';
}

function autoDisposer(value: unknown): Disposer {
  if (typeof value === 'function') {
    // A bare unsubscribe/cleanup function returned by a subscribe() call.
    return value as Disposer;
  }
  if (value !== null && typeof value === 'object') {
    for (const method of DISPOSE_METHODS) {
      if (hasMethod(value, method)) {
        return () => (value as Record<string, () => MaybePromise<void>>)[method]();
      }
    }
    const symbolDispose = (Symbol as { dispose?: symbol }).dispose;
    if (symbolDispose && hasMethod(value, symbolDispose as unknown as string)) {
      return () => (value as unknown as Record<symbol, () => void>)[symbolDispose]();
    }
  }
  throw new Error(
    `trackDisposables().add() received a ${describeValue(value)} with no ` +
      `dispose/stop/close/destroy/shutdown method. Pass an explicit disposer: ` +
      `add(value, (v) => v.yourTeardown()).`,
  );
}

export interface TrackOptions {
  /**
   * `'each'` (default) disposes after every test, right for anything built
   * inside a test body. `'all'` disposes once at the end of the file, right
   * for something built in `beforeAll` and shared by the file's tests.
   */
  readonly scope?: 'each' | 'all';
}

export function trackDisposables(options: TrackOptions = {}): DisposableRegistry {
  const entries: Array<{ readonly label: string; readonly dispose: Disposer }> = [];

  const flush = async (): Promise<void> => {
    const failures: string[] = [];
    // Reverse order: later registrations usually depend on earlier ones.
    while (entries.length > 0) {
      const entry = entries.pop();
      if (!entry) break;
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      // Surfaced, never swallowed, a teardown that throws is a real defect,
      // and hiding it is how a leak survives a green suite.
      throw new Error(`disposal failed for ${failures.length} item(s):\n  ${failures.join('\n  ')}`);
    }
  };

  if (options.scope === 'all') {
    afterAll(flush);
  } else {
    afterEach(flush);
    // A file that registers something outside a test body (in `beforeAll`, or
    // at module scope) has nothing for the per-test hook to drain at the end.
    afterAll(flush);
  }

  return {
    add<T>(value: T, disposer?: (value: T) => MaybePromise<void>): T {
      const dispose: Disposer = disposer ? () => disposer(value) : autoDisposer(value);
      entries.push({ label: describeValue(value), dispose });
      return value;
    },
    defer(fn: Disposer): void {
      entries.push({ label: 'deferred cleanup', dispose: fn });
    },
    flush,
    get size(): number {
      return entries.length;
    },
  };
}
