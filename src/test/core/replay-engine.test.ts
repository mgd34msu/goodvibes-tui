/**
 * Tests for DeterministicReplayEngine — Section 5.2
 *
 * Covers: load (valid/empty), step (forward/boundary), seek,
 * diff (match/mismatch), export path validation, engine state transitions.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeterministicReplayEngine,
} from '../../core/deterministic-replay.ts';
import { handleReplayCommand } from '../../core/replay-command-handler.ts';
import type { LedgerEntry } from '../../runtime/telemetry/exporters/local-ledger.ts';
import type { RuntimeStateSnapshot } from '../../runtime/diagnostics/types.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: RuntimeStateSnapshot = {
  capturedAt: 1_700_000_000_000,
  domains: [],
};

const SNAPSHOT_WITH_DOMAINS: RuntimeStateSnapshot = {
  capturedAt: 1_700_000_000_000,
  domains: [
    { domain: 'turn', revision: 1, lastUpdatedAt: 1_700_000_000_000, state: { count: 0 } },
    { domain: 'session', revision: 1, lastUpdatedAt: 1_700_000_000_000, state: { id: 'sess-1' } },
  ],
};

const REPLAY_COMMAND_PROJECT_ROOT = process.cwd();

function makeEntry(rev: number, eventName: string, payload: unknown = {}): LedgerEntry {
  return {
    runId: 'run-test-1',
    rev,
    eventName,
    payload,
    ts: 1_700_000_000_000 + rev * 1000,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadEngine(
  engine: DeterministicReplayEngine,
  entries: LedgerEntry[],
  snapshot: RuntimeStateSnapshot = EMPTY_SNAPSHOT,
): void {
  engine.load('run-test-1', snapshot, entries);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DeterministicReplayEngine', () => {
  let engine: DeterministicReplayEngine;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gv-replay-root-'));
    engine = new DeterministicReplayEngine(projectRoot);
  });

  // ── load ──────────────────────────────────────────────────────────────────

  describe('load', () => {
    test('status becomes loaded after loading entries', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      expect(engine.getSnapshot().status).toBe('loaded');
    });

    test('status becomes exhausted when loaded with 0 entries', () => {
      loadEngine(engine, []);
      expect(engine.getSnapshot().status).toBe('exhausted');
    });

    test('starts at rev 0 (initial snapshot)', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')]);
      const snap = engine.getSnapshot();
      expect(snap.currentRev).toBe(0);
      expect(snap.totalRevisions).toBe(2);
    });

    test('replaces any previously loaded run', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.load('run-2', SNAPSHOT_WITH_DOMAINS, [makeEntry(1, 'turn:error')]);
      expect(engine.getSnapshot().runId).toBe('run-2');
    });

    test('sorts entries by revision regardless of input order', () => {
      const entries = [makeEntry(3, 'turn:complete'), makeEntry(1, 'turn:start'), makeEntry(2, 'turn:tool-executing')];
      loadEngine(engine, entries);
      engine.step(3);
      const snap = engine.getSnapshot();
      expect(snap.currentRev).toBe(3);
    });

    test('snapshot domains are reflected in the initial frame', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')], SNAPSHOT_WITH_DOMAINS);
      const frame = engine.getSnapshot().currentFrame;
      expect(frame?.domains['turn']).toBeDefined();
      expect(frame?.domains['session']).toBeDefined();
    });
  });

  // ── step ──────────────────────────────────────────────────────────────────

  describe('step', () => {
    test('advances cursor by 1 and returns one frame', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')]);
      const frames = engine.step();
      expect(frames).toHaveLength(1);
      expect(frames[0].rev).toBe(1);
    });

    test('advances cursor by n', () => {
      loadEngine(engine, [
        makeEntry(1, 'turn:start'),
        makeEntry(2, 'turn:tool-executing'),
        makeEntry(3, 'turn:complete'),
      ]);
      const frames = engine.step(3);
      expect(frames).toHaveLength(3);
      expect(engine.getSnapshot().currentRev).toBe(3);
    });

    test('returns empty array when already exhausted', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.step(); // go to end
      const frames = engine.step();
      expect(frames).toHaveLength(0);
      expect(engine.getSnapshot().status).toBe('exhausted');
    });

    test('returns empty array and warns when idle', () => {
      const frames = engine.step();
      expect(frames).toHaveLength(0);
    });

    test('stepping past the end clamps to last revision', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')]);
      engine.step(100);
      expect(engine.getSnapshot().status).toBe('exhausted');
      expect(engine.getSnapshot().currentRev).toBe(2);
    });

    test('status is exhausted after stepping through all events', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.step();
      expect(engine.getSnapshot().status).toBe('exhausted');
    });
  });

  // ── seek ──────────────────────────────────────────────────────────────────

  describe('seek', () => {
    test('seeks to rev 0 (initial snapshot)', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')]);
      engine.step(2);
      engine.seek(0);
      expect(engine.getSnapshot().currentRev).toBe(0);
    });

    test('seeks to a specific rev', () => {
      loadEngine(engine, [
        makeEntry(1, 'turn:start'),
        makeEntry(2, 'turn:tool-executing'),
        makeEntry(3, 'turn:complete'),
      ]);
      engine.seek(2);
      expect(engine.getSnapshot().currentRev).toBe(2);
    });

    test('clamps to last rev when target exceeds total', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.seek(999);
      expect(engine.getSnapshot().currentRev).toBe(1);
      expect(engine.getSnapshot().status).toBe('exhausted');
    });

    test('clamps to 0 when target is negative', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.seek(-5);
      expect(engine.getSnapshot().currentRev).toBe(0);
    });

    test('seek(0) sets status to loaded (not running)', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')]);
      engine.step(2);
      expect(engine.getSnapshot().status).toBe('exhausted');
      engine.seek(0);
      expect(engine.getSnapshot().currentRev).toBe(0);
      expect(engine.getSnapshot().status).toBe('loaded');
    });

    test('no-op and warns when idle', () => {
      // should not throw
      expect(() => engine.seek(5)).not.toThrow();
    });
  });

  // ── diff ──────────────────────────────────────────────────────────────────

  describe('diff', () => {
    test('returns empty array when no mismatches', () => {
      const entries = [
        makeEntry(1, 'turn:start', { prompt: 'hello' }),
        makeEntry(2, 'turn:complete', { response: 'world' }),
      ];
      loadEngine(engine, entries);
      // Step through all entries so frames match the recording.
      engine.step(2);
      const mismatches = engine.diff();
      expect(mismatches).toHaveLength(0);
    });

    test('returns empty array when idle', () => {
      expect(engine.diff()).toHaveLength(0);
    });

    test('detects payload key mismatch', () => {
      // Load engine with an entry that has payload { prompt: 'hello' }.
      // Then overwrite _entries with an entry that has an extra key { prompt: 'hello', extra: 'field' }
      // so that diff() finds the recorded entry has keys the frame does not.
      loadEngine(engine, [makeEntry(1, 'turn:start', { prompt: 'hello' })]);
      // Replace the recorded entry in _entries with one that has extra keys.
      // The frame was built from { prompt: 'hello' } but the recorded entry now
      // claims { prompt: 'hello', extra: 'field' } — a genuine payload_mismatch.
      (engine as unknown as { _entries: LedgerEntry[] })._entries = [
        makeEntry(1, 'turn:start', { prompt: 'hello', extra: 'field' }),
      ];
      const mismatches = engine.diff();
      expect(mismatches.length).toBeGreaterThan(0);
      expect(mismatches[0].kind).toBe('payload_mismatch');
      expect(mismatches[0].failureMode).toBe('payload_schema_mismatch');
      expect(mismatches[0].ownerDomain).toBe('unknown');
    });

    test('stores mismatches on snapshot after diff', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.diff();
      expect(Array.isArray(engine.getSnapshot().mismatches)).toBe(true);
    });

    test('classifies turn stop-reason divergence as state_divergence', () => {
      loadEngine(engine, [
        makeEntry(1, 'TURN_SUBMITTED', { turnId: 'turn-1', prompt: 'hello' }),
        makeEntry(2, 'TURN_COMPLETED', { turnId: 'turn-1', response: 'done', stopReason: 'completed' }),
      ]);
      (engine as unknown as { _entries: LedgerEntry[] })._entries = [
        makeEntry(1, 'TURN_SUBMITTED', { turnId: 'turn-1', prompt: 'hello' }),
        makeEntry(2, 'TURN_COMPLETED', { turnId: 'turn-1', response: 'done', stopReason: 'empty_response' }),
      ];
      const mismatches = engine.diff();
      expect(mismatches.some((m) => m.kind === 'state_divergence' && m.description.includes('stop reason diverged'))).toBe(true);
      const stopReasonMismatch = mismatches.find((m) => m.failureMode === 'stop_reason_diverged');
      expect(stopReasonMismatch?.ownerDomain).toBe('turn');
      expect(stopReasonMismatch?.relatedTurnId).toBe('turn-1');
    });

    test('classifies ordering mismatches with owner domain and related turn id', () => {
      loadEngine(engine, [
        makeEntry(1, 'TURN_SUBMITTED', { turnId: 'turn-2', prompt: 'hello' }),
        makeEntry(2, 'STREAM_START', { turnId: 'turn-2' }),
      ]);
      (engine as unknown as { _entries: LedgerEntry[] })._entries = [
        makeEntry(1, 'TURN_SUBMITTED', { turnId: 'turn-2', prompt: 'hello' }),
        makeEntry(2, 'TURN_COMPLETED', { turnId: 'turn-2', response: 'done', stopReason: 'completed' }),
      ];
      const mismatches = engine.diff();
      const orderingMismatch = mismatches.find((m) => m.failureMode === 'ordering_violation');
      expect(orderingMismatch).toBeDefined();
      expect(orderingMismatch?.ownerDomain).toBe('turn');
      expect(orderingMismatch?.relatedTurnId).toBe('turn-2');
    });
  });

  describe('turn summaries', () => {
    test('summarizes completed, failed, and cancelled turns from typed ledger events', () => {
      loadEngine(engine, [
        makeEntry(1, 'TURN_SUBMITTED', { turnId: 'turn-ok', prompt: 'one' }),
        makeEntry(2, 'TURN_COMPLETED', { turnId: 'turn-ok', response: 'done', stopReason: 'completed' }),
        makeEntry(3, 'TURN_SUBMITTED', { turnId: 'turn-fail', prompt: 'two' }),
        makeEntry(4, 'TURN_ERROR', { turnId: 'turn-fail', error: 'provider blew up', stopReason: 'provider_error' }),
        makeEntry(5, 'TURN_SUBMITTED', { turnId: 'turn-cancel', prompt: 'three' }),
        makeEntry(6, 'TURN_CANCEL', { turnId: 'turn-cancel', reason: 'user aborted', stopReason: 'cancelled' }),
      ]);

      expect(engine.getSnapshot().turnSummaries).toEqual([
        {
          turnId: 'turn-ok',
          outcome: 'completed',
          terminalEvent: 'TURN_COMPLETED',
          startedRev: 1,
          terminalRev: 2,
          stopReason: 'completed',
          message: 'done',
        },
        {
          turnId: 'turn-fail',
          outcome: 'failed',
          terminalEvent: 'TURN_ERROR',
          startedRev: 3,
          terminalRev: 4,
          stopReason: 'provider_error',
          message: 'provider blew up',
        },
        {
          turnId: 'turn-cancel',
          outcome: 'cancelled',
          terminalEvent: 'TURN_CANCEL',
          startedRev: 5,
          terminalRev: 6,
          stopReason: 'cancelled',
          message: 'user aborted',
        },
      ]);
    });
  });

  // ── export path validation ─────────────────────────────────────────────────

  describe('export path validation', () => {
    test('throws on path traversal outside cwd and /tmp', async () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      await expect(engine.export('/etc/passwd')).rejects.toThrow(
        'Export path must be within project directory or /tmp',
      );
    });

    test('throws when path resolves to parent directory', async () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      await expect(engine.export('../../etc/evil.json')).rejects.toThrow(
        'Export path must be within project directory or /tmp',
      );
    });

    test('returns without throwing when idle', async () => {
      // export() returns early (no throw) when idle.
      await expect(engine.export('/tmp/test.json')).resolves.toBeUndefined();
    });

    test('accepts /tmp paths', async () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      const path = join(tmpdir(), `replay-test-${Date.now()}.json`);
      await expect(engine.export(path)).resolves.toBeUndefined();
    });
  });

  // ── state transitions ─────────────────────────────────────────────────────

  describe('state transitions', () => {
    test('idle → loaded → running → exhausted', () => {
      expect(engine.getSnapshot().status).toBe('idle');
      loadEngine(engine, [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')]);
      expect(engine.getSnapshot().status).toBe('loaded');
      engine.step();
      expect(engine.getSnapshot().status).toBe('running');
      engine.step();
      expect(engine.getSnapshot().status).toBe('exhausted');
    });

    test('idle → exhausted when loading 0 entries', () => {
      loadEngine(engine, []);
      expect(engine.getSnapshot().status).toBe('exhausted');
    });

    test('reset returns to idle', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.reset();
      expect(engine.getSnapshot().status).toBe('idle');
      expect(engine.getSnapshot().runId).toBeNull();
    });

    test('seek to last rev produces exhausted status', () => {
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      engine.seek(1);
      expect(engine.getSnapshot().status).toBe('exhausted');
    });
  });

  // ── subscribe / notify ────────────────────────────────────────────────────

  describe('subscribe', () => {
    test('notified on load', () => {
      let calls = 0;
      engine.subscribe(() => { calls++; });
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      expect(calls).toBeGreaterThanOrEqual(1);
    });

    test('unsubscribe stops notifications', () => {
      let calls = 0;
      const unsub = engine.subscribe(() => { calls++; });
      unsub();
      loadEngine(engine, [makeEntry(1, 'turn:start')]);
      expect(calls).toBe(0);
    });
  });

});

// ── replay command handler ─────────────────────────────────────────────────

describe('handleReplayCommand', () => {
  test('loads a run and reports available entries', () => {
    const engine = new DeterministicReplayEngine(REPLAY_COMMAND_PROJECT_ROOT);
    const ledger = {
      listRunIds: () => ['run-test-1'],
      readRunEntries: () => [makeEntry(1, 'turn:start'), makeEntry(2, 'turn:complete')],
    };

    const result = handleReplayCommand({ replayEngine: engine }, 'load', ['run-test-1'], ledger);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Run "run-test-1" loaded.');
    expect(engine.getSnapshot().status).toBe('loaded');
  });

  test('returns usage when no replay engine ledger is available', () => {
    const engine = new DeterministicReplayEngine(REPLAY_COMMAND_PROJECT_ROOT);
    const result = handleReplayCommand({ replayEngine: engine }, 'load', [], undefined);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('No ledger configured');
  });
});
