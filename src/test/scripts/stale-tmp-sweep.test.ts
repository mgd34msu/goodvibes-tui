import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepStaleTestTmp, DEFAULT_STALE_MS } from '../../../scripts/stale-tmp-sweep.ts';

// Exercises the .test-tmp stale sweep (scripts/stale-tmp-sweep.ts). This is the
// BACKSTOP, not the primary cleanup: makeProjectTempDir leftovers
// (<prefix>-<random>) are removed when the owning test process finishes, by the
// afterAll in src/test/preload/temp-cleanup.ts. What reaches this sweep is what
// a signal-killed process (SIGKILL, OOM) never got to clean, plus orphaned
// run-<pid> subtrees. The age gate is what keeps it concurrency-safe.

describe('sweepStaleTestTmp', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `gv-sweep-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeEntry(name: string, ageMs: number): string {
    const full = join(root, name);
    mkdirSync(full, { recursive: true });
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(full, when, when);
    return full;
  }

  test('removes a stale makeProjectTempDir leftover (killed process, non-run- prefix)', () => {
    const stale = makeEntry('gv-agent-lifecycle-ab12cd', 2 * DEFAULT_STALE_MS);
    const removed = sweepStaleTestTmp(root);
    expect(existsSync(stale)).toBe(false);
    expect(removed).toContain('gv-agent-lifecycle-ab12cd');
  });

  test('removes a stale orphaned run-<pid> runner subtree', () => {
    const stale = makeEntry('run-99999', 2 * DEFAULT_STALE_MS);
    sweepStaleTestTmp(root);
    expect(existsSync(stale)).toBe(false);
  });

  test('keeps a fresh entry — a live concurrent runner is never touched', () => {
    const fresh = makeEntry('run-12345', 0);
    const freshLeftover = makeEntry('gv-plugin-test-xy99zz', 5_000);
    const removed = sweepStaleTestTmp(root);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(freshLeftover)).toBe(true);
    expect(removed).toHaveLength(0);
  });

  test('honors an injected clock + threshold', () => {
    const entry = makeEntry('gv-test-runtime-q1', 0);
    // now advanced 10 minutes past creation, threshold 5 minutes -> stale.
    const removed = sweepStaleTestTmp(root, { now: Date.now() + 10 * 60_000, staleMs: 5 * 60_000 });
    expect(existsSync(entry)).toBe(false);
    expect(removed).toContain('gv-test-runtime-q1');
  });

  test('is a safe no-op when the root does not exist', () => {
    const missing = join(root, 'does-not-exist');
    expect(sweepStaleTestTmp(missing)).toEqual([]);
  });
});
