/**
 * Timer-leak detector for the single-process `bun test` suite.
 *
 * Why this exists: every test file in this repo runs inside ONE bun process.
 * A test that starts a poller (`setInterval`, or a `setTimeout` chain that
 * reschedules itself) and never stops it keeps firing for the rest of the run,
 * inside every later test file. That is how `provider-stream-retry.test.ts`
 * came to observe 4962 `fetch` calls where it expected 2: it counted calls made
 * by pollers that unrelated, already-finished tests had left running.
 *
 * `process._getActiveHandles()` is a stub under Bun 1.3.14 (it returns an empty
 * array even with a live interval), so handle state has to be tracked directly.
 * This module wraps the timer globals, records a creation stack for each live
 * handle, and attributes anything still live to the test file that started it.
 *
 * Usage (opt-in, so the default suite pays nothing):
 *   GOODVIBES_LEAK_DETECT=1 bun test --preload ./test/_helpers/leak-detector.ts ...
 *   GOODVIBES_LEAK_REPORT=/path/report.json   # optional machine-readable dump
 *
 * `scripts/leak-scan.ts` wires both up.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, afterAll } from 'bun:test';

interface LiveTimer {
  readonly id: number;
  readonly kind: 'interval' | 'timeout' | 'immediate';
  readonly delayMs: number;
  readonly stack: string;
  readonly origin: string;
  readonly createdDuring: string;
  fired: number;
}

interface LeakRecord {
  readonly kind: string;
  readonly delayMs: number;
  readonly origin: string;
  readonly createdDuring: string;
  readonly fired: number;
  readonly refd: boolean;
  readonly site: string;
  readonly stack: string;
}

/**
 * The frame that actually created the timer, the single most useful field when
 * deciding what a test must dispose, because it names the class that owns it.
 */
function parseSite(stack: string): string {
  for (const line of stack.split('\n')) {
    if (SELF.test(line)) continue;
    const match = REPO_FILE.exec(line);
    if (match) {
      const fn = /at\s+(?:async\s+)?([^\s(]+)\s*\(/.exec(line)?.[1] ?? '';
      const file = match[1].replace(/^.*\/(test|packages|src)\//, '$1/');
      return fn ? `${fn} (${file})` : file;
    }
  }
  return '<unknown site>';
}

const ENABLED = process.env.GOODVIBES_LEAK_DETECT === '1';

/** Frames from the detector itself and from bun's own internals are noise. */
const SELF = /leak-detector\.ts/;
const TEST_FILE = /([^\s()]+\.test\.ts)/;
const REPO_FILE = /([^\s()]+\.(?:ts|tsx|mjs|js)):\d+:\d+/;

/**
 * The test file whose stack we most recently saw. Bun runs test files serially,
 * so a timer created from an async continuation (no test frame on its stack,
 * a rescheduling poller, a promise callback) still belongs to whichever file
 * was executing. That makes the heuristic a reliable owner, not a guess.
 */
let lastKnownTestFile = '<startup>';

function parseOrigin(stack: string): string {
  const lines = stack.split('\n');
  for (const line of lines) {
    if (SELF.test(line)) continue;
    const t = TEST_FILE.exec(line);
    if (t) {
      lastKnownTestFile = t[1].replace(/^.*\/test\//, 'test/');
      return lastKnownTestFile;
    }
  }
  for (const line of lines) {
    if (SELF.test(line)) continue;
    const r = REPO_FILE.exec(line);
    if (r) {
      const product = r[1].replace(/^.*\/(test|packages|src)\//, '$1/');
      return `${product} [via ${lastKnownTestFile}]`;
    }
  }
  return `<unattributed> [via ${lastKnownTestFile}]`;
}

const live = new Map<number, LiveTimer>();
/** Cleared handles that fired anyway, kept only for the summary counters. */
let totalCreated = 0;
let totalCleared = 0;
let currentTest = '<startup>';
let seq = 0;

/** Per-test attribution: handles alive at the end of the test that made them. */
const perTestLeaks = new Map<string, number>();

function install(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const origSetInterval = g.setInterval as (...a: unknown[]) => unknown;
  const origSetTimeout = g.setTimeout as (...a: unknown[]) => unknown;
  const origSetImmediate = g.setImmediate as ((...a: unknown[]) => unknown) | undefined;
  const origClearInterval = g.clearInterval as (h: unknown) => void;
  const origClearTimeout = g.clearTimeout as (h: unknown) => void;
  const origClearImmediate = g.clearImmediate as ((h: unknown) => void) | undefined;

  /** Handles are objects under Bun; a WeakMap keeps the id without mutating them. */
  const handleIds = new WeakMap<object, number>();
  const idHandles = new Map<number, unknown>();

  function track(handle: unknown, kind: LiveTimer['kind'], delayMs: number): void {
    const id = ++seq;
    const stack = new Error('timer').stack ?? '';
    const rec: LiveTimer = {
      id,
      kind,
      delayMs,
      stack,
      origin: parseOrigin(stack),
      createdDuring: currentTest,
      fired: 0,
    };
    live.set(id, rec);
    idHandles.set(id, handle);
    if (handle && typeof handle === 'object') handleIds.set(handle as object, id);
    totalCreated += 1;
  }

  function untrack(handle: unknown): void {
    if (!handle || typeof handle !== 'object') return;
    const id = handleIds.get(handle as object);
    if (id === undefined) return;
    if (live.delete(id)) totalCleared += 1;
    idHandles.delete(id);
  }

  g.setInterval = (fn: unknown, delay?: unknown, ...rest: unknown[]): unknown => {
    let id = -1;
    const wrapped = (...a: unknown[]): unknown => {
      const rec = live.get(id);
      if (rec) rec.fired += 1;
      return (fn as (...x: unknown[]) => unknown)(...a);
    };
    const handle = origSetInterval(wrapped, delay, ...rest);
    track(handle, 'interval', typeof delay === 'number' ? delay : 0);
    id = seq;
    return handle;
  };

  g.setTimeout = (fn: unknown, delay?: unknown, ...rest: unknown[]): unknown => {
    let id = -1;
    const wrapped = (...a: unknown[]): unknown => {
      // A one-shot timeout stops being a live handle the moment it fires.
      const rec = live.get(id);
      if (rec) {
        rec.fired += 1;
        live.delete(id);
        idHandles.delete(id);
      }
      return (fn as (...x: unknown[]) => unknown)(...a);
    };
    const handle = origSetTimeout(wrapped, delay, ...rest);
    track(handle, 'timeout', typeof delay === 'number' ? delay : 0);
    id = seq;
    return handle;
  };

  if (origSetImmediate) {
    g.setImmediate = (fn: unknown, ...rest: unknown[]): unknown => {
      let id = -1;
      const wrapped = (...a: unknown[]): unknown => {
        const rec = live.get(id);
        if (rec) {
          rec.fired += 1;
          live.delete(id);
          idHandles.delete(id);
        }
        return (fn as (...x: unknown[]) => unknown)(...a);
      };
      const handle = origSetImmediate(wrapped, ...rest);
      track(handle, 'immediate', 0);
      id = seq;
      return handle;
    };
  }

  g.clearInterval = (h: unknown): void => {
    untrack(h);
    origClearInterval(h);
  };
  g.clearTimeout = (h: unknown): void => {
    untrack(h);
    origClearTimeout(h);
  };
  if (origClearImmediate) {
    g.clearImmediate = (h: unknown): void => {
      untrack(h);
      origClearImmediate(h);
    };
  }

  (globalThis as Record<string, unknown>).__leakDetectorIdHandles = idHandles;
}

function isRefd(handle: unknown): boolean {
  if (handle && typeof handle === 'object' && 'hasRef' in handle) {
    try {
      return Boolean((handle as { hasRef(): boolean }).hasRef());
    } catch {
      return true;
    }
  }
  return true;
}

function snapshot(): readonly LeakRecord[] {
  const idHandles = (globalThis as Record<string, unknown>).__leakDetectorIdHandles as
    | Map<number, unknown>
    | undefined;
  return [...live.values()].map((rec) => ({
    kind: rec.kind,
    delayMs: rec.delayMs,
    origin: rec.origin,
    createdDuring: rec.createdDuring,
    fired: rec.fired,
    refd: isRefd(idHandles?.get(rec.id)),
    site: parseSite(rec.stack),
    stack: rec.stack,
  }));
}

if (ENABLED) {
  install();

  afterEach(() => {
    // Runs AFTER the file's own afterEach hooks (verified ordering under Bun
    // 1.3.14), so anything still live here survived the test's own cleanup.
    for (const rec of live.values()) {
      if (rec.createdDuring === currentTest && rec.kind === 'interval') {
        perTestLeaks.set(currentTest, (perTestLeaks.get(currentTest) ?? 0) + 1);
        break;
      }
    }
    currentTest = '<between-tests>';
  });

  afterAll(() => {
    const leaks = snapshot();
    const byOrigin = new Map<string, LeakRecord[]>();
    for (const leak of leaks) {
      const list = byOrigin.get(leak.origin) ?? [];
      list.push(leak);
      byOrigin.set(leak.origin, list);
    }

    const lines: string[] = [];
    lines.push('');
    lines.push('=== timer-leak report ===');
    lines.push(`timers created: ${totalCreated}`);
    lines.push(`timers cleared: ${totalCleared}`);
    lines.push(`live at end of run: ${leaks.length}`);
    const intervals = leaks.filter((l) => l.kind === 'interval');
    // Intervals are the actionable number: they repeat forever and run inside
    // every later test file. A still-pending one-shot timeout is usually just a
    // sleep that had not elapsed when the run ended, it fires once and clears
    // itself, so it cannot pollute a later test the way a poller does.
    lines.push(`  of which intervals (pollers): ${intervals.length}   <-- the actionable number`);
    lines.push(`  one-shot timeouts still pending: ${leaks.length - intervals.length}`);
    const totalFires = leaks.reduce((n, l) => n + l.fired, 0);
    lines.push(`  callbacks fired by still-live handles: ${totalFires}`);
    lines.push('');

    // Creation sites, pollers first, this names the class that must be disposed.
    const bySite = new Map<string, { live: number; fired: number; kinds: Set<string> }>();
    for (const leak of leaks) {
      const entry = bySite.get(leak.site) ?? { live: 0, fired: 0, kinds: new Set<string>() };
      entry.live += 1;
      entry.fired += leak.fired;
      entry.kinds.add(leak.kind);
      bySite.set(leak.site, entry);
    }
    lines.push('  --- by creation site (what to dispose) ---');
    const siteRows = [...bySite.entries()].sort((a, b) => {
      const aPoll = a[1].kinds.has('interval') ? 1 : 0;
      const bPoll = b[1].kinds.has('interval') ? 1 : 0;
      return bPoll - aPoll || b[1].live - a[1].live;
    });
    for (const [site, entry] of siteRows.slice(0, 25)) {
      lines.push(
        `  ${String(entry.live).padStart(4)} live  ${[...entry.kinds].join('+').padEnd(9)} fired=${String(entry.fired).padEnd(6)} ${site}`,
      );
    }
    lines.push('');
    const sorted = [...byOrigin.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [origin, list] of sorted) {
      const fires = list.reduce((n, l) => n + l.fired, 0);
      const kinds = list.reduce<Record<string, number>>((acc, l) => {
        acc[l.kind] = (acc[l.kind] ?? 0) + 1;
        return acc;
      }, {});
      lines.push(
        `  ${origin}: ${list.length} live (${Object.entries(kinds)
          .map(([k, n]) => `${k}=${n}`)
          .join(' ')}) fired=${fires}`,
      );
    }
    lines.push('=== end timer-leak report ===');
    console.log(lines.join('\n'));

    const reportPath = process.env.GOODVIBES_LEAK_REPORT;
    if (reportPath) {
      try {
        mkdirSync(dirname(reportPath), { recursive: true });
        // Synchronous on purpose: `Bun.write` is async and the process can exit
        // before the report is flushed.
        writeFileSync(
          reportPath,
          JSON.stringify(
            {
              totalCreated,
              totalCleared,
              liveAtEnd: leaks.length,
              intervalsLive: intervals.length,
              callbacksFiredByLiveHandles: totalFires,
              byOrigin: sorted.map(([origin, list]) => ({
                origin,
                live: list.length,
                fired: list.reduce((n, l) => n + l.fired, 0),
                samples: list.slice(0, 3),
              })),
            },
            null,
            2,
          ),
        );
      } catch {
        // Reporting must never fail a run.
      }
    }
  });
}

export const leakDetector = {
  enabled: ENABLED,
  snapshot,
  setCurrentTest(name: string): void {
    currentTest = name;
  },
  counts(): { created: number; cleared: number; live: number } {
    return { created: totalCreated, cleared: totalCleared, live: live.size };
  },
};
