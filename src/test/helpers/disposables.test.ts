// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
/**
 * disposables.test.ts
 *
 * Guards the two pieces of test-support code the suite now relies on to stop
 * what it starts: `trackDisposables()` (helpers/disposables.ts) and
 * `resetTestRuntimeServices()` (helpers/runtime-services.ts).
 *
 * Both are load-bearing and both fail SILENTLY. If `trackDisposables()` stopped
 * draining its registry, or if `resetTestRuntimeServices()` went back to just
 * dropping the reference, no other test in the repo would fail — the damage is
 * a graph's worth of pollers still ticking, which only `scripts/leak-scan.ts`
 * can see. So the teardown behaviour itself is asserted here.
 *
 * Cross-test observation is deliberate: a disposal that is supposed to happen
 * "after each test" can only be proven by a LATER test reading the flag.
 */
import { describe, expect, test } from 'bun:test';

import { trackDisposables } from './disposables.ts';
import { getTestRuntimeServices, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from './runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

const disposables = trackDisposables();

describe('trackDisposables — disposes what a test registers', () => {
  const log: string[] = [];

  test('registers values with dispose/stop/close and returns them unchanged', () => {
    const withDispose = disposables.add({
      disposed: false,
      dispose() {
        this.disposed = true;
        log.push('dispose');
      },
    });
    const withStop = disposables.add({
      stopped: false,
      stop() {
        this.stopped = true;
        log.push('stop');
      },
    });
    const withClose = disposables.add({
      closed: false,
      close() {
        this.closed = true;
        log.push('close');
      },
    });

    // add() hands the value straight back so it can wrap a constructor call.
    expect(withDispose.disposed).toBe(false);
    expect(withStop.stopped).toBe(false);
    expect(withClose.closed).toBe(false);
    expect(disposables.size).toBe(3);
  });

  test('everything registered by the previous test was disposed after it', () => {
    // The real assertion: the afterEach hook fired and drained the registry.
    expect(disposables.size).toBe(0);
    // LIFO — later registrations unwind first.
    expect(log).toEqual(['close', 'stop', 'dispose']);
  });
});

describe('trackDisposables — explicit disposers and bare callbacks', () => {
  const seen: string[] = [];

  test('an explicit disposer overrides method detection', () => {
    const target = { dispose: (): void => { seen.push('WRONG-auto'); } };
    disposables.add(target, () => { seen.push('explicit'); });
    disposables.defer(() => { seen.push('deferred'); });
    expect(seen).toEqual([]);
  });

  test('the explicit disposer ran and the auto one did not', () => {
    expect(seen).toEqual(['deferred', 'explicit']);
    expect(seen).not.toContain('WRONG-auto');
  });
});

describe('trackDisposables — refuses to silently leak', () => {
  test('a value with no teardown method is rejected loudly', () => {
    expect(() => disposables.add({ notDisposable: true })).toThrow(
      /no dispose\/stop\/close\/destroy\/shutdown method/,
    );
    // Nothing was registered, so nothing is silently leaked.
    expect(disposables.size).toBe(0);
  });

  test('a disposer that throws is surfaced, not swallowed', async () => {
    const local = trackDisposables();
    local.add({
      dispose: () => {
        throw new Error('teardown exploded');
      },
    });
    await expect(local.flush()).rejects.toThrow(/teardown exploded/);
    // The registry is drained even when disposal failed, so a retry is clean.
    expect(local.size).toBe(0);
  });

  test('flush is idempotent and disposes each item exactly once', async () => {
    const local = trackDisposables();
    let count = 0;
    local.add({
      dispose: () => {
        count += 1;
      },
    });
    await local.flush();
    await local.flush();
    expect(count).toBe(1);
  });
});

/**
 * Timers created between `install()` and `restore()`, minus the ones cleared in
 * that window. Self-contained rather than leaning on the GOODVIBES_LEAK_DETECT
 * preload, so this runs and fails in the ordinary suite.
 */
function trackTimers() {
  const liveIntervals = new Set<unknown>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;

  globalThis.setInterval = ((fn: never, ms?: never, ...rest: never[]) => {
    const handle = realSetInterval(fn, ms, ...rest);
    liveIntervals.add(handle);
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: never) => {
    liveIntervals.delete(handle);
    return realClearInterval(handle);
  }) as typeof globalThis.clearInterval;

  return {
    get liveCount(): number {
      return liveIntervals.size;
    },
    restore(): void {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      // Whatever this probe saw still running must not outlive the probe.
      for (const handle of liveIntervals) realClearInterval(handle as never);
      liveIntervals.clear();
    },
  };
}

describe('resetTestRuntimeServices — stops the graph it drops', () => {
  test('every poller the shared test graph started is cleared when it is reset', () => {
    resetTestRuntimeServices();
    const timers = trackTimers();
    try {
      const services = getTestRuntimeServices();
      // Same graph until it is reset — the sanity check that makes the
      // measurement below mean something.
      expect(getTestRuntimeServices()).toBe(services);

      // Guards the false pass where the graph stopped composing anything and
      // the leak count reads zero for entirely the wrong reason.
      const started = timers.liveCount;
      expect(started).toBeGreaterThan(3);

      resetTestRuntimeServices();
      expect(timers.liveCount).toBe(0);

      // ...and the next request builds a fresh, running graph.
      const rebuilt = getTestRuntimeServices();
      expect(rebuilt).not.toBe(services);
      expect(timers.liveCount).toBeGreaterThan(3);
      resetTestRuntimeServices();
      expect(timers.liveCount).toBe(0);
    } finally {
      timers.restore();
    }
  });

  test('resetting twice is a no-op rather than an error', () => {
    getTestRuntimeServices();
    resetTestRuntimeServices();
    expect(() => resetTestRuntimeServices()).not.toThrow();
  });
});
