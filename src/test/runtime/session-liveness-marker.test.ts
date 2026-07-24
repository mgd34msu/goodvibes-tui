/**
 * Tests for session-liveness-marker.ts — marker lifecycle (write/refresh/
 * remove) plus the best-effort liveness check (fresh+alive, stale, missing,
 * pid-not-alive) that the boot resume notice's suppression and /session
 * resume's confirm gate both build on.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  checkSessionLiveness,
  isPidAlive,
  LIVENESS_STALE_AFTER_MS,
  livenessMarkerPathFor,
  removeLivenessMarker,
  writeLivenessMarker,
} from '../../runtime/session-liveness-marker.ts';

let tmpHome: string;
let surface: SessionSurface;

beforeEach(() => {
  tmpHome = makeProjectTempDir('gv-liveness-marker');
  surface = makeTestSurface(tmpHome);
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe('livenessMarkerPathFor', () => {
  test('builds the canonical path under .goodvibes/tui/liveness', () => {
    const path = livenessMarkerPathFor(makeTestSurface('/home/user'), 'ses-abc');
    expect(path).toBe('/home/user/.goodvibes/tui/liveness/ses-abc.json');
  });
});

describe('writeLivenessMarker / removeLivenessMarker', () => {
  test('writes a marker file with sessionId, pid, and updatedAt', () => {
    writeLivenessMarker(surface, 'ses-1', 4242);
    const path = livenessMarkerPathFor(surface, 'ses-1');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.sessionId).toBe('ses-1');
    expect(parsed.pid).toBe(4242);
    expect(typeof parsed.updatedAt).toBe('number');
  });

  test('creates parent directories lazily', () => {
    writeLivenessMarker(surface, 'ses-nested', 1);
    expect(existsSync(livenessMarkerPathFor(surface, 'ses-nested'))).toBe(true);
  });

  test('a second write refreshes updatedAt in place', async () => {
    writeLivenessMarker(surface, 'ses-refresh', 1);
    const path = livenessMarkerPathFor(surface, 'ses-refresh');
    const first = JSON.parse(readFileSync(path, 'utf-8')).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    writeLivenessMarker(surface, 'ses-refresh', 1);
    const second = JSON.parse(readFileSync(path, 'utf-8')).updatedAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test('removeLivenessMarker deletes the file', () => {
    writeLivenessMarker(surface, 'ses-rm', 1);
    const path = livenessMarkerPathFor(surface, 'ses-rm');
    expect(existsSync(path)).toBe(true);
    removeLivenessMarker(surface, 'ses-rm');
    expect(existsSync(path)).toBe(false);
  });

  test('removeLivenessMarker on a missing marker never throws', () => {
    expect(() => removeLivenessMarker(surface, 'never-existed')).not.toThrow();
  });

  test('writeLivenessMarker never throws even against an unwritable home dir', () => {
    // '/dev/null/impossible' cannot be mkdir'd (parent is a device file, not a dir).
    expect(() => writeLivenessMarker('/dev/null/impossible', 'ses-x', 1)).not.toThrow();
  });
});

describe('isPidAlive', () => {
  test('returns true when the injected kill does not throw', () => {
    expect(isPidAlive(123, () => { /* no throw = alive */ })).toBe(true);
  });

  test('returns false on ESRCH (no such process)', () => {
    const kill = () => { const err = new Error('no such process') as NodeJS.ErrnoException; err.code = 'ESRCH'; throw err; };
    expect(isPidAlive(123, kill)).toBe(false);
  });

  test('returns true on EPERM (process exists but not signalable)', () => {
    const kill = () => { const err = new Error('perm') as NodeJS.ErrnoException; err.code = 'EPERM'; throw err; };
    expect(isPidAlive(123, kill)).toBe(true);
  });

  test('the real process.kill-based default resolves this test process (self) as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('checkSessionLiveness', () => {
  test('no marker at all → not live', () => {
    const result = checkSessionLiveness(surface, 'never-written');
    expect(result).toEqual({ live: false, pid: null });
  });

  test('fresh marker + alive pid → live, with the pid reported', () => {
    writeLivenessMarker(surface, 'ses-live', 555);
    const result = checkSessionLiveness(surface, 'ses-live', { isPidAliveFn: () => true });
    expect(result).toEqual({ live: true, pid: 555 });
  });

  test('fresh marker but pid no longer alive → not live (stale marker after a crash)', () => {
    writeLivenessMarker(surface, 'ses-dead', 555);
    const result = checkSessionLiveness(surface, 'ses-dead', { isPidAliveFn: () => false });
    expect(result).toEqual({ live: false, pid: null });
  });

  test('marker older than LIVENESS_STALE_AFTER_MS → not live, even if the pid resolves alive (guards pid reuse)', () => {
    writeLivenessMarker(surface, 'ses-stale', 555);
    const farFuture = Date.now() + LIVENESS_STALE_AFTER_MS + 10_000;
    const result = checkSessionLiveness(surface, 'ses-stale', {
      now: () => farFuture,
      isPidAliveFn: () => true, // pid coincidentally reused by an unrelated process
    });
    expect(result).toEqual({ live: false, pid: null });
  });

  test('marker just under the staleness cutoff with an alive pid → still live', () => {
    writeLivenessMarker(surface, 'ses-fresh-edge', 555);
    const justUnder = Date.now() + LIVENESS_STALE_AFTER_MS - 1_000;
    const result = checkSessionLiveness(surface, 'ses-fresh-edge', {
      now: () => justUnder,
      isPidAliveFn: () => true,
    });
    expect(result).toEqual({ live: true, pid: 555 });
  });

  test('corrupt marker file → treated as absent, never throws', () => {
    writeLivenessMarker(surface, 'ses-corrupt', 1);
    const path = livenessMarkerPathFor(surface, 'ses-corrupt');
    writeFileSync(path, 'not json{{{');
    expect(() => checkSessionLiveness(surface, 'ses-corrupt')).not.toThrow();
    expect(checkSessionLiveness(surface, 'ses-corrupt')).toEqual({ live: false, pid: null });
  });

  test('removed marker is honestly reported as not live', () => {
    writeLivenessMarker(surface, 'ses-removed', 1);
    removeLivenessMarker(surface, 'ses-removed');
    const result = checkSessionLiveness(surface, 'ses-removed', { isPidAliveFn: () => true });
    expect(result).toEqual({ live: false, pid: null });
  });
});
