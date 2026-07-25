/**
 * Tests for reapStaleLivenessMarkers — the reclaim half of the liveness-marker
 * lifecycle. `removeLivenessMarker` only runs on a clean exit, so before this
 * sweep existed every crashed session left a marker file behind permanently.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  LIVENESS_STALE_AFTER_MS,
  livenessMarkerDirFor,
  livenessMarkerPathFor,
  reapStaleLivenessMarkers,
  writeLivenessMarker,
} from '../../runtime/session-liveness-marker.ts';

let tmpHome: string;
let surface: SessionSurface;

const NOW = 1_800_000_000_000;
/** Old enough that the marker is past LIVENESS_STALE_AFTER_MS at NOW. */
const STALE_AT = NOW - LIVENESS_STALE_AFTER_MS - 60_000;

beforeEach(() => {
  tmpHome = makeProjectTempDir('gv-liveness-reap');
  surface = makeTestSurface(tmpHome);
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

/** Write a marker with an exact updatedAt so staleness is deterministic. */
function putMarker(sessionId: string, pid: number, updatedAt: number): string {
  const path = livenessMarkerPathFor(surface, sessionId);
  mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
  writeFileSync(path, JSON.stringify({ sessionId, pid, updatedAt }));
  return path;
}

const deadPid = () => false;
const alivePid = () => true;

describe('reapStaleLivenessMarkers', () => {
  test('a stale marker whose pid is dead is reaped while a live marker for this process survives', () => {
    const crashed = putMarker('crashed-session', 999_999, STALE_AT);
    writeLivenessMarker(surface, 'my-session', process.pid);
    const mine = livenessMarkerPathFor(surface, 'my-session');

    const result = reapStaleLivenessMarkers(surface, {
      now: () => NOW,
      // Only the crashed session's pid is reported dead; this process is alive.
      isPidAliveFn: (pid: number) => pid === process.pid,
    });

    expect(result.scanned).toBe(2);
    expect(result.reaped).toBe(1);
    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  test('a marker that is stale but whose pid still resolves alive is left alone', () => {
    const path = putMarker('wedged-owner', 4242, STALE_AT);
    const result = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: alivePid });
    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a fresh marker whose pid is dead is left for a later sweep, not deleted immediately', () => {
    const path = putMarker('just-died', 4242, NOW - 5_000);
    const result = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: deadPid });
    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a zero-byte marker left by a crash between create and write is reaped', () => {
    mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
    const path = livenessMarkerPathFor(surface, 'torn-write');
    writeFileSync(path, '');

    const result = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: alivePid });

    expect(result.reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('a truncated / unparseable marker is reaped rather than kept forever', () => {
    mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
    const path = livenessMarkerPathFor(surface, 'half-json');
    writeFileSync(path, '{"sessionId":"half-json","pid":1');

    expect(reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: alivePid }).reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('a marker whose shape is wrong (pid not a number) is reaped', () => {
    mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
    const path = livenessMarkerPathFor(surface, 'wrong-shape');
    writeFileSync(path, JSON.stringify({ sessionId: 'wrong-shape', pid: 'not-a-pid', updatedAt: STALE_AT }));

    expect(reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: deadPid }).reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('keepSessionIds protects a session even when its marker looks reapable', () => {
    const path = putMarker('protected-session', 999_999, STALE_AT);
    const result = reapStaleLivenessMarkers(surface, {
      now: () => NOW,
      isPidAliveFn: deadPid,
      keepSessionIds: ['protected-session'],
    });
    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('the count cap drops the oldest survivors when the liveness rule cannot bound the directory', () => {
    // Every pid reports alive (the EPERM / reused-pid case), so nothing is
    // reapable by the liveness rule alone — the cap is the only bound left.
    for (let i = 0; i < 5; i++) putMarker(`survivor-${i}`, 100 + i, NOW - i * 1_000);

    const result = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: alivePid, maxFiles: 2 });

    expect(result.reaped).toBe(3);
    const left = readdirSync(livenessMarkerDirFor(surface)).sort();
    // The two most recently updated survive.
    expect(left).toEqual(['survivor-0.json', 'survivor-1.json']);
  });

  test('reaping twice in a row is a no-op the second time', () => {
    putMarker('crashed-a', 999_998, STALE_AT);
    putMarker('crashed-b', 999_999, STALE_AT);

    const first = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: deadPid });
    const second = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: deadPid });

    expect(first.reaped).toBe(2);
    expect(second.scanned).toBe(0);
    expect(second.reaped).toBe(0);
  });

  test('a marker deleted by another sweeper between the listing and the unlink is not an error', () => {
    const path = putMarker('raced-session', 999_999, STALE_AT);

    let raced = false;
    const result = reapStaleLivenessMarkers(surface, {
      now: () => NOW,
      // Stand in for a second TUI instance winning the race: the file is gone
      // by the time this sweep reaches its unlink.
      isPidAliveFn: () => {
        if (!raced) {
          raced = true;
          unlinkSync(path);
        }
        return false;
      },
    });

    expect(raced).toBe(true);
    expect(result.reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('a missing liveness directory reclaims nothing and never throws', () => {
    expect(() => reapStaleLivenessMarkers(surface)).not.toThrow();
    expect(reapStaleLivenessMarkers(surface)).toEqual({ scanned: 0, reaped: 0 });
  });

  test('non-marker files in the liveness directory are ignored', () => {
    mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
    const stray = `${livenessMarkerDirFor(surface)}/README.txt`;
    writeFileSync(stray, 'not a marker');

    const result = reapStaleLivenessMarkers(surface, { now: () => NOW, isPidAliveFn: deadPid });

    expect(result.scanned).toBe(0);
    expect(existsSync(stray)).toBe(true);
  });
});
