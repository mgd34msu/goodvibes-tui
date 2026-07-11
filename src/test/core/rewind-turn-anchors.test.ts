import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
import {
  clearTurnAnchors,
  getTurnAnchors,
  persistTurnAnchors,
  recordTurnAnchor,
  resolveTurnAnchor,
  restoreTurnAnchors,
  type TurnAnchor,
} from '../../core/rewind-turn-anchors.ts';

const tempDirs: string[] = [];
function makeWorkingDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-anchors-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function anchor(turnId: string, messageCount: number): TurnAnchor {
  return { turnId, label: `turn ${turnId}`, messageCount, at: 1_000 + messageCount };
}

describe('rewind-turn-anchors persistence', () => {
  test('anchors survive a simulated resume: persist, clear the in-memory registry, restore', () => {
    const workingDir = makeWorkingDir();
    const sessionId = 'user-resume-roundtrip';

    recordTurnAnchor(sessionId, anchor('t1', 6));
    recordTurnAnchor(sessionId, anchor('t2', 14));
    persistTurnAnchors(sessionId, workingDir);

    // Simulate a fresh process: the in-memory registry is gone.
    clearTurnAnchors(sessionId);
    expect(getTurnAnchors(sessionId)).toHaveLength(0);

    const restored = restoreTurnAnchors(sessionId, workingDir);
    expect(restored).toBe(2);

    const anchors = getTurnAnchors(sessionId);
    expect(anchors.map((a) => a.turnId)).toEqual(['t1', 't2']);
    expect(resolveTurnAnchor(sessionId, 't2')?.messageCount).toBe(14);
    clearTurnAnchors(sessionId);
  });

  test('restore is a no-op (returns 0) when no sidecar exists', () => {
    const workingDir = makeWorkingDir();
    expect(restoreTurnAnchors('user-never-saved', workingDir)).toBe(0);
  });

  test('a malformed sidecar restores nothing and does not throw', () => {
    const workingDir = makeWorkingDir();
    const sessionId = 'user-corrupt';
    const sessionsDir = operations.getUserSessionsDir(workingDir, 'tui');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${sessionId}.anchors.json`), '{ not valid json');
    expect(restoreTurnAnchors(sessionId, workingDir)).toBe(0);
    expect(getTurnAnchors(sessionId)).toHaveLength(0);
  });

  test('restore keeps a single entry per turnId when a turn is re-recorded (idempotent)', () => {
    const workingDir = makeWorkingDir();
    const sessionId = 'user-idempotent';
    recordTurnAnchor(sessionId, anchor('t1', 6));
    persistTurnAnchors(sessionId, workingDir);
    clearTurnAnchors(sessionId);

    restoreTurnAnchors(sessionId, workingDir);
    // A live turn re-records the same turnId after resume — must not duplicate.
    recordTurnAnchor(sessionId, anchor('t1', 6));
    expect(getTurnAnchors(sessionId)).toHaveLength(1);
    clearTurnAnchors(sessionId);
  });

  test('persist writes nothing (no crash) for an empty registry', () => {
    const workingDir = makeWorkingDir();
    persistTurnAnchors('user-empty', workingDir);
    expect(restoreTurnAnchors('user-empty', workingDir)).toBe(0);
  });

  test('a sessionId with a path separator is refused (no directory escape)', () => {
    const workingDir = makeWorkingDir();
    recordTurnAnchor('safe', anchor('t1', 3));
    // Should not throw and should not write outside the sessions dir.
    persistTurnAnchors('../escape', workingDir);
    expect(restoreTurnAnchors('../escape', workingDir)).toBe(0);
    clearTurnAnchors('safe');
  });
});
