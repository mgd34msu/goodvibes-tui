/**
 * recovery-decisions.test.ts — the durable ledger behind "Remove means remove".
 *
 * recovery-prompt.test.ts covers the flow; this file covers the storage on its
 * own: where the file lands, that a decision survives a restart, that the
 * ledger cannot grow without bound, and that a damaged one degrades into "no
 * decisions recorded" instead of taking a boot down.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  isRecoveryRemovalRecorded,
  readRecoveryRemovals,
  recordRecoveryRemoval,
  recoveryDecisionsPathFor,
  type RecoveryRemovalRecord,
} from '../../runtime/recovery-decisions.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-recovery-decisions');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Write the ledger file directly, standing in for whatever an earlier run left behind. */
function seedLedger(contents: string): void {
  const path = recoveryDecisionsPathFor(surface);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('where the ledger lives', () => {
  test('it is home-anchored under the surface, beside the liveness markers', () => {
    expect(recoveryDecisionsPathFor(surface))
      .toBe(join(surface.homeDirectory, '.goodvibes', surface.surfaceRoot, 'recovery-decisions.json'));
  });

  test('home-anchored, NOT project-anchored — one decision covers every project', () => {
    // The snapshots this defends against include the SDK's legacy shared
    // recovery directory, which is home-anchored and read by the launch of
    // every project. A project-scoped ledger would ask once per project.
    const otherProject = makeTestSurface(join(tmpDir, 'another-project'), tmpDir);
    recordRecoveryRemoval(surface, 'sess-everywhere');

    expect(isRecoveryRemovalRecorded(otherProject, 'sess-everywhere')).toBe(true);
    expect(recoveryDecisionsPathFor(otherProject)).toBe(recoveryDecisionsPathFor(surface));
  });
});

describe('a decision survives the process that made it', () => {
  test('a recorded removal reads back through a freshly built surface', () => {
    recordRecoveryRemoval(surface, 'sess-remembered');

    const relaunched = makeTestSurface(tmpDir);
    expect(isRecoveryRemovalRecorded(relaunched, 'sess-remembered')).toBe(true);
    expect(isRecoveryRemovalRecorded(relaunched, 'sess-never-asked-about')).toBe(false);
  });

  test('the record names the workspace the decision was made in', () => {
    recordRecoveryRemoval(surface, 'sess-provenance');
    const records = readRecoveryRemovals(surface);
    expect(records).toHaveLength(1);
    expect(records[0]?.workspace).toBe(surface.workingDirectory);
  });

  test('an empty session id is not a decision about anything', () => {
    recordRecoveryRemoval(surface, '   ');
    expect(existsSync(recoveryDecisionsPathFor(surface))).toBe(false);
    expect(isRecoveryRemovalRecorded(surface, '')).toBe(false);
  });
});

describe('the ledger stays bounded', () => {
  test('removing the same session twice refreshes one record rather than adding a second', () => {
    // The reappearing-snapshot case: without this the ledger would grow by one
    // entry every time the file came back.
    recordRecoveryRemoval(surface, 'sess-repeat', Date.now() - 1000);
    recordRecoveryRemoval(surface, 'sess-repeat');

    const records = readRecoveryRemovals(surface);
    expect(records).toHaveLength(1);
    expect(records[0]?.sessionId).toBe('sess-repeat');
  });

  test('records expire, so a ledger cannot accumulate forever', () => {
    const longAgo = Date.now() - 200 * DAY_MS;
    seedLedger(JSON.stringify([
      { sessionId: 'sess-ancient', workspace: tmpDir, removedAt: longAgo },
      { sessionId: 'sess-recent', workspace: tmpDir, removedAt: Date.now() - DAY_MS },
    ]));

    expect(isRecoveryRemovalRecorded(surface, 'sess-ancient')).toBe(false);
    expect(isRecoveryRemovalRecorded(surface, 'sess-recent')).toBe(true);
  });

  test('the newest decisions are the ones kept when the count cap bites', () => {
    const many: RecoveryRemovalRecord[] = Array.from({ length: 400 }, (_, i) => ({
      sessionId: `sess-${i}`,
      workspace: tmpDir,
      removedAt: Date.now() - (400 - i) * 1000,
    }));
    seedLedger(JSON.stringify(many));
    recordRecoveryRemoval(surface, 'sess-newest');

    const records = readRecoveryRemovals(surface);
    expect(records.length).toBeLessThanOrEqual(200);
    expect(records.at(-1)?.sessionId).toBe('sess-newest');
    expect(records.some((r) => r.sessionId === 'sess-399')).toBe(true);
    expect(records.some((r) => r.sessionId === 'sess-0')).toBe(false);
  });

  test('a removed snapshot\'s absence from disk is NOT a reason to forget the decision', () => {
    // Stated as a test because it is the one pruning rule that would look
    // tidy and would reinstate the defect: every record here describes a file
    // that was just deleted, and the point is to still remember when it
    // comes back.
    recordRecoveryRemoval(surface, 'sess-gone');
    expect(existsSync(surface.recoveryFile('sess-gone'))).toBe(false);
    expect(isRecoveryRemovalRecorded(makeTestSurface(tmpDir), 'sess-gone')).toBe(true);
  });
});

describe('a damaged ledger degrades instead of throwing', () => {
  test('unparseable contents read as no decisions recorded', () => {
    seedLedger('{ this is not json');
    expect(readRecoveryRemovals(surface)).toEqual([]);
    expect(isRecoveryRemovalRecorded(surface, 'sess-anything')).toBe(false);
  });

  test('a JSON value of the wrong shape reads as no decisions recorded', () => {
    seedLedger(JSON.stringify({ sessionId: 'not-an-array' }));
    expect(readRecoveryRemovals(surface)).toEqual([]);
  });

  test('malformed entries are dropped while the well-formed ones survive', () => {
    seedLedger(JSON.stringify([
      { sessionId: 'sess-good', workspace: tmpDir, removedAt: Date.now() },
      { sessionId: '', workspace: tmpDir, removedAt: Date.now() },
      { sessionId: 'sess-no-time', workspace: tmpDir },
      'a bare string',
      null,
    ]));

    expect(readRecoveryRemovals(surface).map((r) => r.sessionId)).toEqual(['sess-good']);
  });

  test('a missing ledger is simply no decisions, and writing one creates its directory', () => {
    expect(readRecoveryRemovals(surface)).toEqual([]);
    recordRecoveryRemoval(surface, 'sess-first');
    expect(JSON.parse(readFileSync(recoveryDecisionsPathFor(surface), 'utf-8'))).toHaveLength(1);
  });
});
