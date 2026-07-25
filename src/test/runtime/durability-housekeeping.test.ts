/**
 * Tests for durability-housekeeping.ts — the one composition point that runs
 * every crash-residue reap, aggregates the counts, and discloses them.
 *
 * The disclosure half matters as much as the deletion half: a silent sweep is
 * indistinguishable from data loss, and an always-on "reclaimed 0" line would
 * train readers to ignore the line that actually matters.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { QUARANTINE_RETENTION_MS, UNRECOGNIZED_SUFFIX } from '../../config/read-versioned.ts';
import { ANCHOR_SIDECAR_SETTLE_MS } from '../../core/rewind-turn-anchors.ts';
import { JOURNAL_ORPHAN_MAX_AGE_MS, journalPathFor } from '../../core/transcript-journal.ts';
import { LIVENESS_STALE_AFTER_MS, livenessMarkerDirFor, livenessMarkerPathFor } from '../../runtime/session-liveness-marker.ts';
import {
  runDurabilityHousekeeping,
  startDurabilityHousekeeping,
} from '../../runtime/durability-housekeeping.ts';

interface CapturedLog {
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

let tmpDir: string;
let surface: SessionSurface;
let infoLogs: CapturedLog[];
let restoreInfo: () => void;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-durability-housekeeping');
  surface = makeTestSurface(tmpDir);
  mkdirSync(surface.sessionsDir, { recursive: true });
  mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });

  infoLogs = [];
  const original = logger.info.bind(logger);
  logger.info = (message: string, data?: Record<string, unknown>) => { infoLogs.push({ message, data }); };
  restoreInfo = () => { logger.info = original; };
});

afterEach(() => {
  restoreInfo();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A pid this host really has no process for, so the sweep's alive probe
 * reports it dead. Probed rather than hard-coded: any fixed number can
 * coincidentally be in use on a busy machine, which would make this test flaky.
 */
function findUnusedPid(): number {
  for (let pid = 400_000; pid < 420_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no unused pid found in the probed range');
}

function ageTo(path: string, msAgo: number): void {
  const at = new Date(Date.now() - msAgo);
  utimesSync(path, at, at);
}

/** A liveness marker for a pid that is certainly not running, stamped stale. */
function putDeadMarker(sessionId: string): string {
  mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
  const path = livenessMarkerPathFor(surface, sessionId);
  // A never-parseable marker is residue on content alone, so this needs no
  // dependence on which pids happen to exist on the test host.
  writeFileSync(path, '');
  return path;
}

function putOrphanJournal(sessionId: string): string {
  const path = journalPathFor(surface, sessionId);
  writeFileSync(path, '{"version":1,"sessionId":"x","createdAt":1}\n');
  ageTo(path, JOURNAL_ORPHAN_MAX_AGE_MS + 86_400_000);
  return path;
}

function putOldQuarantine(name: string): string {
  const path = join(tmpDir, '.goodvibes', 'tui', `${name}${UNRECOGNIZED_SUFFIX}`);
  writeFileSync(path, 'corrupt');
  ageTo(path, QUARANTINE_RETENTION_MS + 86_400_000);
  return path;
}

function putOrphanSidecar(sessionId: string): string {
  const path = join(surface.sessionsDir, `${sessionId}.anchors.json`);
  writeFileSync(path, JSON.stringify({ version: 1, sessionId, anchors: [{ turnId: 't1', label: 'x', messageCount: 1, at: 1 }] }));
  // Past the settle window, so the sweep treats it as residue rather than as a
  // file another instance might still be rewriting.
  ageTo(path, ANCHOR_SIDECAR_SETTLE_MS + 86_400_000);
  return path; // no <sessionId>.jsonl beside it — the owner is gone
}

describe('runDurabilityHousekeeping', () => {
  test('reclaims residue from all four stores and reports the per-store counts', () => {
    const marker = putDeadMarker('crashed-a');
    const journal = putOrphanJournal('crashed-b');
    const quarantine = putOldQuarantine('settings.json');
    const sidecar = putOrphanSidecar('deleted-session');

    const outcome = runDurabilityHousekeeping({ surface, currentSessionId: () => 'live-session' });

    expect(outcome).toEqual({
      livenessMarkers: 1,
      transcriptJournals: 1,
      quarantineFiles: 1,
      anchorSidecars: 1,
      total: 4,
    });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(quarantine)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
  });

  test('the disclosure line carries the per-store counts and the total', () => {
    putDeadMarker('crashed-a');
    putOrphanJournal('crashed-b');
    putOrphanSidecar('deleted-session');

    runDurabilityHousekeeping({ surface });

    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0].message).toContain('durability housekeeping');
    expect(infoLogs[0].data).toEqual({
      livenessMarkers: 1,
      transcriptJournals: 1,
      quarantineFiles: 0,
      anchorSidecars: 1,
      total: 3,
    });
  });

  test('a sweep that reclaims nothing logs nothing', () => {
    const outcome = runDurabilityHousekeeping({ surface });
    expect(outcome.total).toBe(0);
    expect(infoLogs).toHaveLength(0);
  });

  test('nothing belonging to the current session is reclaimed', () => {
    const sessionId = 'my-live-session';
    const journal = journalPathFor(surface, sessionId);
    writeFileSync(journal, '{"version":1,"sessionId":"my-live-session","createdAt":1}\n');
    ageTo(journal, JOURNAL_ORPHAN_MAX_AGE_MS + 86_400_000);
    const sidecar = putOrphanSidecar(sessionId);

    const outcome = runDurabilityHousekeeping({ surface, currentSessionId: () => sessionId });

    expect(outcome.total).toBe(0);
    expect(existsSync(journal)).toBe(true);
    expect(existsSync(sidecar)).toBe(true);
  });

  test('a marker refreshed by this very process survives the sweep', () => {
    mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
    const path = livenessMarkerPathFor(surface, 'this-process');
    writeFileSync(path, JSON.stringify({ sessionId: 'this-process', pid: process.pid, updatedAt: Date.now() }));

    runDurabilityHousekeeping({ surface });

    expect(existsSync(path)).toBe(true);
  });

  test('a stale marker for a pid that cannot be running is reclaimed', () => {
    mkdirSync(livenessMarkerDirFor(surface), { recursive: true });
    const path = livenessMarkerPathFor(surface, 'crashed-owner');
    writeFileSync(path, JSON.stringify({ sessionId: 'crashed-owner', pid: findUnusedPid(), updatedAt: Date.now() - LIVENESS_STALE_AFTER_MS - 60_000 }));

    const outcome = runDurabilityHousekeeping({ surface });

    expect(outcome.livenessMarkers).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test('one failing step never aborts the others and never throws to the caller', () => {
    const journal = putOrphanJournal('crashed-b');
    const sidecar = putOrphanSidecar('deleted-session');

    let outcome: ReturnType<typeof runDurabilityHousekeeping> | null = null;
    expect(() => {
      outcome = runDurabilityHousekeeping({
        surface,
        currentSessionId: () => { throw new Error('session id unavailable'); },
      });
    }).not.toThrow();

    // The remaining reaps still ran.
    expect(outcome).not.toBeNull();
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);
  });

  test('running twice in a row reclaims nothing the second time and discloses nothing', () => {
    putDeadMarker('crashed-a');
    putOrphanJournal('crashed-b');
    putOrphanSidecar('deleted-session');

    const first = runDurabilityHousekeeping({ surface });
    infoLogs.length = 0;
    const second = runDurabilityHousekeeping({ surface });

    expect(first.total).toBe(3);
    expect(second.total).toBe(0);
    expect(infoLogs).toHaveLength(0);
  });

  test('extra quarantine directories supplied by the caller are swept too', () => {
    const configDir = join(tmpDir, 'control-plane');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, `rules.json${UNRECOGNIZED_SUFFIX}`);
    writeFileSync(path, 'corrupt');
    ageTo(path, QUARANTINE_RETENTION_MS + 86_400_000);

    const outcome = runDurabilityHousekeeping({ surface, extraQuarantineDirs: [configDir] });

    expect(outcome.quarantineFiles).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});

describe('startDurabilityHousekeeping', () => {
  test('sweeps once immediately, keeps sweeping on the timer, and stops when disposed', async () => {
    const first = putOrphanJournal('crashed-first');

    const stop = startDurabilityHousekeeping({ surface }, { intervalMs: 15 });
    try {
      // The startup sweep already ran, synchronously.
      expect(existsSync(first)).toBe(false);

      // Residue that appears AFTER boot is reclaimed by the repeating sweep —
      // the point of scheduling it at all.
      const second = putOrphanJournal('crashed-second');
      await Bun.sleep(120);
      expect(existsSync(second)).toBe(false);

      stop();

      const third = putOrphanJournal('crashed-third');
      await Bun.sleep(120);
      expect(existsSync(third)).toBe(true);
    } finally {
      stop();
    }
  });

  test('the disposer is safe to call more than once', () => {
    const stop = startDurabilityHousekeeping({ surface }, { intervalMs: 60_000 });
    expect(() => { stop(); stop(); }).not.toThrow();
  });
});
