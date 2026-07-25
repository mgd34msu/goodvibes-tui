/**
 * Tests for reapOrphanedAnchorSidecars — the owner of a `<id>.anchors.json`
 * sidecar is the `<id>.jsonl` session file beside it. Deleting a session
 * removed the JSONL but nothing ever removed the sidecar, so anchors for
 * sessions that no longer exist used to persist forever.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  ANCHOR_SIDECAR_SETTLE_MS,
  ANCHOR_TMP_MAX_AGE_MS,
  clearTurnAnchors,
  persistTurnAnchors,
  recordTurnAnchor,
  reapOrphanedAnchorSidecars,
  restoreTurnAnchors,
  type TurnAnchor,
} from '../../core/rewind-turn-anchors.ts';

let tmpDir: string;
let surface: SessionSurface;

const NOW = 1_800_000_000_000;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-anchor-reap');
  surface = makeTestSurface(tmpDir);
  mkdirSync(surface.sessionsDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function anchor(turnId: string, messageCount: number): TurnAnchor {
  return { turnId, label: `turn ${turnId}`, messageCount, at: 1_000 + messageCount };
}

/** Stamp a file's mtime `msAgo` before NOW. */
function ageTo(path: string, msAgo: number): void {
  const at = new Date(NOW - msAgo);
  utimesSync(path, at, at);
}

/**
 * Write a valid sidecar for `sessionId`, optionally with its owning session
 * file. Aged past the settle window by default so it is a reap candidate — a
 * freshly written sidecar is deliberately out of the sweep's reach.
 */
function putSidecar(sessionId: string, withSessionFile: boolean, ageMs = ANCHOR_SIDECAR_SETTLE_MS + 60_000): string {
  recordTurnAnchor(sessionId, anchor('t1', 3));
  persistTurnAnchors(sessionId, surface);
  clearTurnAnchors(sessionId);
  if (withSessionFile) writeFileSync(join(surface.sessionsDir, `${sessionId}.jsonl`), '{"role":"user"}\n');
  const path = join(surface.sessionsDir, `${sessionId}.anchors.json`);
  ageTo(path, ageMs);
  return path;
}

describe('reapOrphanedAnchorSidecars', () => {
  test('a sidecar is reaped when its session file is gone, and kept when it is present', () => {
    const orphan = putSidecar('deleted-session', false);
    const owned = putSidecar('still-here', true);

    const result = reapOrphanedAnchorSidecars(surface, { now: () => NOW });

    expect(result.reaped).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(owned)).toBe(true);
  });

  test('the current session sidecar is never reaped even before its session file exists', () => {
    const path = putSidecar('brand-new-session', false);
    const result = reapOrphanedAnchorSidecars(surface, { now: () => NOW, currentSessionId: 'brand-new-session' });
    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a sidecar written moments ago is left alone, so a rewrite by another instance is never raced', () => {
    const path = putSidecar('being-rewritten', false, 1_000);
    const result = reapOrphanedAnchorSidecars(surface, { now: () => NOW });
    expect(result.reaped).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('a zero-byte sidecar from a crashed write restores nothing AND is reaped', () => {
    const sessionId = 'torn-write';
    writeFileSync(join(surface.sessionsDir, `${sessionId}.jsonl`), '{"role":"user"}\n');
    const path = join(surface.sessionsDir, `${sessionId}.anchors.json`);
    writeFileSync(path, '');
    ageTo(path, ANCHOR_SIDECAR_SETTLE_MS + 60_000);

    // The read path already refuses to serve it...
    expect(restoreTurnAnchors(sessionId, surface)).toBe(0);
    // ...and the sweep reclaims it rather than leaving it looking like state.
    expect(reapOrphanedAnchorSidecars(surface, { now: () => NOW }).reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('a truncated sidecar whose session survives is reaped because it can restore nothing', () => {
    const sessionId = 'half-written';
    writeFileSync(join(surface.sessionsDir, `${sessionId}.jsonl`), '{"role":"user"}\n');
    const path = join(surface.sessionsDir, `${sessionId}.anchors.json`);
    writeFileSync(path, '{"version":1,"sessionId":"half-written","anchors":[{"turnId"');
    ageTo(path, ANCHOR_SIDECAR_SETTLE_MS + 60_000);

    expect(restoreTurnAnchors(sessionId, surface)).toBe(0);
    expect(reapOrphanedAnchorSidecars(surface, { now: () => NOW }).reaped).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('an abandoned staging file is reaped once it is past the age window; a young one is left alone', () => {
    const stale = join(surface.sessionsDir, 'a.anchors.json.tmp-4242');
    const fresh = join(surface.sessionsDir, 'b.anchors.json.tmp-4243');
    writeFileSync(stale, '{"partial"');
    writeFileSync(fresh, '{"partial"');
    const old = new Date(NOW - ANCHOR_TMP_MAX_AGE_MS - 60_000);
    utimesSync(stale, old, old);
    const recent = new Date(NOW - 1_000);
    utimesSync(fresh, recent, recent);

    const result = reapOrphanedAnchorSidecars(surface, { now: () => NOW });

    expect(result.reaped).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('reaping twice in a row is a no-op the second time', () => {
    putSidecar('gone-a', false);
    putSidecar('gone-b', false);

    const first = reapOrphanedAnchorSidecars(surface, { now: () => NOW });
    const second = reapOrphanedAnchorSidecars(surface, { now: () => NOW });

    expect(first.reaped).toBe(2);
    expect(second).toEqual({ scanned: 0, reaped: 0 });
  });

  test('a valid sidecar with its session present still restores after a sweep', () => {
    const sessionId = 'survives-sweep';
    putSidecar(sessionId, true);

    reapOrphanedAnchorSidecars(surface, { now: () => NOW });

    expect(restoreTurnAnchors(sessionId, surface)).toBe(1);
    clearTurnAnchors(sessionId);
  });

  test('an unreadable or missing sessions directory reclaims nothing and never throws', () => {
    const missing = makeTestSurface(join(tmpDir, 'nowhere'));
    expect(() => reapOrphanedAnchorSidecars(missing)).not.toThrow();
    expect(reapOrphanedAnchorSidecars(missing)).toEqual({ scanned: 0, reaped: 0 });
  });

  test('session files and other sessions-directory contents are never touched', () => {
    writeFileSync(join(surface.sessionsDir, 'keeper.jsonl'), '{"role":"user"}\n');
    writeFileSync(join(surface.sessionsDir, 'last-session.json'), '{"id":"keeper"}');

    const result = reapOrphanedAnchorSidecars(surface, { now: () => NOW });

    expect(result.scanned).toBe(0);
    expect(readdirSync(surface.sessionsDir).sort()).toEqual(['keeper.jsonl', 'last-session.json']);
  });
});
