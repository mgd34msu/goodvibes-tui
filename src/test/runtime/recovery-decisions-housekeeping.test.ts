/**
 * recovery-decisions-housekeeping.test.ts — the reaping half of the removal
 * ledger: that its bounds are actually applied to DISK (not merely filtered on
 * read), that every discard is disclosed rather than silent, and that a torn or
 * concurrently-written ledger is never mistaken for an empty one.
 *
 * The defect this covers: the ledger's 200-record cap and 90-day TTL were both
 * correct, but expired records were only filtered in memory on read and only
 * removed from disk the next time the user happened to answer "Remove" — which
 * on most machines is never. And whatever was dropped was dropped in silence,
 * which is indistinguishable from data loss.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { SessionSurface } from '@/runtime/index.ts';
import {
  pruneRecoveryDecisions,
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
  tmpDir = makeProjectTempDir('gv-recovery-housekeeping');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

const DAY_MS = 24 * 60 * 60 * 1000;

function seedLedger(contents: string): void {
  const path = recoveryDecisionsPathFor(surface);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

function readLedgerRaw(): string {
  return readFileSync(recoveryDecisionsPathFor(surface), 'utf-8');
}

function record(sessionId: string, removedAt: number): RecoveryRemovalRecord {
  return { sessionId, workspace: surface.workingDirectory, removedAt };
}

/** Capture the structured data of every logger.info / logger.warn call made inside `fn`. */
function withCapturedLogs<T>(fn: () => T): {
  result: T;
  infos: Array<{ message: string; data?: Record<string, unknown> | undefined }>;
  warns: Array<{ message: string; data?: Record<string, unknown> | undefined }>;
} {
  const infos: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const warns: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const infoSpy = spyOn(logger, 'info').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    infos.push({ message, data });
  }) as never);
  const warnSpy = spyOn(logger, 'warn').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    warns.push({ message, data });
  }) as never);
  try {
    return { result: fn(), infos, warns };
  } finally {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  }
}

describe('the ledger is actually reaped on disk, not just filtered on read', () => {
  test('expired records are removed from the FILE by the prune, not left to accumulate', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([
      record('long-expired', now - 200 * DAY_MS),
      record('just-expired', now - 91 * DAY_MS),
      record('still-live', now - 3 * DAY_MS),
    ], null, 2));

    const outcome = pruneRecoveryDecisions(surface, now);
    expect(outcome.expired).toBe(2);
    expect(outcome.kept).toBe(1);

    // The reap landed on disk — the old defect was that it only ever happened
    // in memory, so the file kept both expired records forever.
    const onDisk = JSON.parse(readLedgerRaw()) as RecoveryRemovalRecord[];
    expect(onDisk.map((r) => r.sessionId)).toEqual(['still-live']);
  });

  test('records past the count cap are removed from the file, newest kept', () => {
    const now = Date.now();
    const overflowing = Array.from({ length: 260 }, (_, index) => record(`sess-${index}`, now - index * 1000));
    // Oldest first, matching what the writer produces.
    overflowing.reverse();
    seedLedger(JSON.stringify(overflowing, null, 2));

    const outcome = pruneRecoveryDecisions(surface, now);
    expect(outcome.overCap).toBe(60);
    expect(outcome.kept).toBe(200);

    const onDisk = JSON.parse(readLedgerRaw()) as RecoveryRemovalRecord[];
    expect(onDisk).toHaveLength(200);
    // The newest survive: those are the ones a reappearing snapshot matches.
    expect(onDisk.at(-1)?.sessionId).toBe('sess-0');
    expect(onDisk.some((r) => r.sessionId === 'sess-259')).toBe(false);
  });

  test('entries that are not records at all are dropped and counted', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([
      record('real', now - DAY_MS),
      { sessionId: '', workspace: 'x', removedAt: now },
      { nonsense: true },
      'a string',
      null,
    ], null, 2));

    const outcome = pruneRecoveryDecisions(surface, now);
    expect(outcome.malformed).toBe(4);
    expect(outcome.kept).toBe(1);
    expect((JSON.parse(readLedgerRaw()) as RecoveryRemovalRecord[]).map((r) => r.sessionId)).toEqual(['real']);
  });

  test('a prune that drops nothing rewrites nothing — idempotent and safe to repeat', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([record('keeper', now - DAY_MS)], null, 2));
    const before = statSync(recoveryDecisionsPathFor(surface)).mtimeMs;

    const first = pruneRecoveryDecisions(surface, now);
    expect(first.expired + first.malformed + first.overCap).toBe(0);
    const second = pruneRecoveryDecisions(surface, now);
    expect(second).toEqual(first);

    // Untouched: a no-op prune must not churn the file, which is what makes it
    // safe for two processes to run at the same moment.
    expect(statSync(recoveryDecisionsPathFor(surface)).mtimeMs).toBe(before);
    expect(readRecoveryRemovals(surface, now).map((r) => r.sessionId)).toEqual(['keeper']);
  });

  test('a second prune over an already-pruned ledger drops nothing further', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([
      record('expired', now - 120 * DAY_MS),
      record('live', now - DAY_MS),
    ], null, 2));

    expect(pruneRecoveryDecisions(surface, now).expired).toBe(1);
    const again = pruneRecoveryDecisions(surface, now);
    expect(again.expired).toBe(0);
    expect(again.malformed).toBe(0);
    expect(again.overCap).toBe(0);
    expect(again.kept).toBe(1);
  });

  test('no ledger on disk is a clean no-op — nothing is created', () => {
    const outcome = pruneRecoveryDecisions(surface, Date.now());
    expect(outcome).toEqual({ expired: 0, malformed: 0, overCap: 0, kept: 0, unreadable: false });
    expect(existsSync(recoveryDecisionsPathFor(surface))).toBe(false);
  });
});

describe('nothing is deleted in silence', () => {
  test('the prune discloses exactly what it discarded, with the ledger path and the bounds', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([
      record('gone-1', now - 100 * DAY_MS),
      record('gone-2', now - 95 * DAY_MS),
      { garbage: 1 },
      record('kept', now - DAY_MS),
    ], null, 2));

    const { infos } = withCapturedLogs(() => pruneRecoveryDecisions(surface, now));
    const disclosure = infos.find((entry) => entry.message.includes('pruned the removal ledger'));
    expect(disclosure).toBeDefined();
    expect(disclosure?.data?.ledger).toBe(recoveryDecisionsPathFor(surface));
    expect(disclosure?.data?.expiredRecords).toBe(2);
    expect(disclosure?.data?.malformedEntries).toBe(1);
    expect(disclosure?.data?.keptRecords).toBe(1);
    expect(disclosure?.data?.ttlDays).toBe(90);
    expect(disclosure?.data?.maxRecords).toBe(200);
  });

  test('a prune with nothing to discard says nothing — disclosure is for deletions, not for boots', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([record('keeper', now - DAY_MS)], null, 2));
    const { infos } = withCapturedLogs(() => pruneRecoveryDecisions(surface, now));
    expect(infos.some((entry) => entry.message.includes('pruned the removal ledger'))).toBe(false);
  });

  test('recording a removal discloses the records that write dropped', () => {
    const now = Date.now();
    seedLedger(JSON.stringify([
      record('expired-a', now - 200 * DAY_MS),
      record('expired-b', now - 91 * DAY_MS),
      record('live', now - DAY_MS),
    ], null, 2));

    const { infos } = withCapturedLogs(() => recordRecoveryRemoval(surface, 'brand-new', now));
    const disclosure = infos.find((entry) => entry.message.includes('dropped records while recording a removal'));
    expect(disclosure).toBeDefined();
    expect(disclosure?.data?.expiredRecords).toBe(2);
    expect(disclosure?.data?.keptRecords).toBe(2);

    const onDisk = JSON.parse(readLedgerRaw()) as RecoveryRemovalRecord[];
    expect(onDisk.map((r) => r.sessionId).sort()).toEqual(['brand-new', 'live']);
  });

  test('an unreadable ledger is reported and LEFT ALONE — "cannot read" never becomes "forgot everything"', () => {
    seedLedger('{ this is not, valid json');
    const before = readLedgerRaw();

    const { result, warns } = withCapturedLogs(() => pruneRecoveryDecisions(surface, Date.now()));
    expect(result.unreadable).toBe(true);
    expect(warns.some((entry) => entry.message.includes('unreadable'))).toBe(true);
    // Not replaced with an empty array: a transient read failure must not be
    // upgraded into a permanent erasure of the user's decisions.
    expect(readLedgerRaw()).toBe(before);
  });

  test('recording onto an unreadable ledger says that it is replacing it', () => {
    seedLedger('    ');
    const { warns } = withCapturedLogs(() => recordRecoveryRemoval(surface, 'sess-after-corruption', Date.now()));
    expect(warns.some((entry) => entry.message.includes('ledger unreadable'))).toBe(true);
    expect(readRecoveryRemovals(surface).map((r) => r.sessionId)).toEqual(['sess-after-corruption']);
  });
});

describe('a crash-damaged ledger is rejected by content, never trusted because it exists', () => {
  test('a zero-byte ledger reads as no decisions and prunes to nothing, without throwing', () => {
    seedLedger('');
    expect(readRecoveryRemovals(surface)).toEqual([]);
    const outcome = pruneRecoveryDecisions(surface, Date.now());
    expect(outcome.unreadable).toBe(true);
    expect(outcome.kept).toBe(0);
  });

  test('a truncated array (crash mid-write) is not served as a partial ledger', () => {
    const now = Date.now();
    const full = JSON.stringify([record('a', now), record('b', now)], null, 2);
    // Cut it off partway through the second record, exactly as an interrupted
    // write would leave it.
    seedLedger(full.slice(0, Math.floor(full.length * 0.6)));
    expect(readRecoveryRemovals(surface, now)).toEqual([]);
    expect(pruneRecoveryDecisions(surface, now).unreadable).toBe(true);
  });

  test('a ledger that parses but is not an array is rejected rather than iterated', () => {
    seedLedger(JSON.stringify({ sessionId: 'not-an-array' }));
    expect(readRecoveryRemovals(surface)).toEqual([]);
    expect(pruneRecoveryDecisions(surface, Date.now()).unreadable).toBe(true);
  });
});

describe('the ledger write survives being interrupted', () => {
  test('writes go through a temp file and land atomically — no torn ledger is ever visible', () => {
    const now = Date.now();
    recordRecoveryRemoval(surface, 'sess-atomic', now);
    const path = recoveryDecisionsPathFor(surface);

    // The final path holds a complete, parseable ledger...
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual([
      { sessionId: 'sess-atomic', workspace: surface.workingDirectory, removedAt: now },
    ]);
    // ...and no temp file is left behind for a later reader to trip over.
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  test('the ledger keeps owner-only permissions after an atomic replace', () => {
    const path = recoveryDecisionsPathFor(surface);
    recordRecoveryRemoval(surface, 'sess-perm-1', Date.now());
    recordRecoveryRemoval(surface, 'sess-perm-2', Date.now());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
