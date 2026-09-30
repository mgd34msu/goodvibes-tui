/**
 * Tests for DivergencePanel diagnostics data provider.
 *
 * Covers:
 *   - subscribe/notify lifecycle (subscriber called on recordTrendEntry)
 *   - getSnapshot() applies bufferLimit slicing
 *   - dispose() clears subscribers
 *   - _notify() error handling (subscriber that throws doesn't crash)
 *   - unsubscribe removes listener
 */

import { describe, it, expect, mock } from 'bun:test';
import { PermissionSimulator } from '@/runtime/index.ts';
import { DivergenceDashboard } from '@/runtime/index.ts';
import { DivergencePanel } from '@/runtime/index.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSimulator() {
  return new PermissionSimulator(
    { mode: 'allow-all' },
    { mode: 'plan' },
    'warn-on-divergence',
  );
}

function makeDashboard(sim?: PermissionSimulator) {
  return new DivergenceDashboard(sim ?? makeSimulator(), 'warn-on-divergence');
}

function makeDivergence(dash?: DivergenceDashboard) {
  return new DivergencePanel(dash ?? makeDashboard());
}

// ── subscribe / notify lifecycle ──────────────────────────────────────────────

describe('DivergencePanel: subscribe / notify', () => {
  it('calls subscriber when recordTrendEntry is invoked', () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    divergence.subscribe(cb);
    divergence.recordTrendEntry();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('calls multiple subscribers on each recordTrendEntry', () => {
    const divergence = makeDivergence();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    divergence.subscribe(cb1);
    divergence.subscribe(cb2);
    divergence.recordTrendEntry();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('calls subscriber on each subsequent recordTrendEntry call', () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    divergence.subscribe(cb);
    divergence.recordTrendEntry();
    divergence.recordTrendEntry();
    divergence.recordTrendEntry();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('does not call subscriber before any recordTrendEntry', () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    divergence.subscribe(cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── unsubscribe ───────────────────────────────────────────────────────────────

describe('DivergencePanel: unsubscribe', () => {
  it('unsubscribe removes the listener', () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    const unsub = divergence.subscribe(cb);
    unsub();
    divergence.recordTrendEntry();
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe of one does not affect other subscribers', () => {
    const divergence = makeDivergence();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    const unsub1 = divergence.subscribe(cb1);
    divergence.subscribe(cb2);
    unsub1();
    divergence.recordTrendEntry();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('calling unsubscribe twice is safe', () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    const unsub = divergence.subscribe(cb);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ── dispose ───────────────────────────────────────────────────────────────────

describe('DivergencePanel: dispose', () => {
  it('dispose() clears all subscribers', () => {
    const divergence = makeDivergence();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    divergence.subscribe(cb1);
    divergence.subscribe(cb2);
    divergence.dispose();
    divergence.recordTrendEntry();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('dispose() is safe to call when no subscribers are registered', () => {
    const divergence = makeDivergence();
    expect(() => divergence.dispose()).not.toThrow();
  });

  it('dispose() is safe to call multiple times', () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    divergence.subscribe(cb);
    divergence.dispose();
    expect(() => divergence.dispose()).not.toThrow();
  });
});

// ── error handling in _notify ─────────────────────────────────────────────────

describe('DivergencePanel: subscriber error handling', () => {
  it('a throwing subscriber does not crash the divergence', async () => {
    const divergence = makeDivergence();
    divergence.subscribe(() => {
      throw new Error('subscriber failure');
    });
    expect(() => divergence.recordTrendEntry()).not.toThrow();
    await flushMicrotasks();
  });

  it('subsequent subscribers are still called when an earlier one throws', async () => {
    const divergence = makeDivergence();
    const cb = mock(() => {});
    divergence.subscribe(() => {
      throw new Error('boom');
    });
    divergence.subscribe(cb);
    divergence.recordTrendEntry();
    await flushMicrotasks();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── getSnapshot bufferLimit slicing ───────────────────────────────────────────

describe('DivergencePanel: getSnapshot() bufferLimit', () => {
  it('getSnapshot() trend is capped at bufferLimit', () => {
    const dash = makeDashboard();
    // Record 5 trend entries in the dashboard
    for (let i = 0; i < 5; i++) {
      dash.recordTrendEntry();
    }
    // DivergencePanel with bufferLimit of 3 should only expose 3 entries
    const divergence = new DivergencePanel(dash, { bufferLimit: 3 });
    const snap = divergence.getSnapshot();
    expect(snap.trend).toHaveLength(3);
  });

  it('getSnapshot() trend is not truncated when trend length is within bufferLimit', () => {
    const dash = makeDashboard();
    dash.recordTrendEntry();
    dash.recordTrendEntry();
    const divergence = new DivergencePanel(dash, { bufferLimit: 10 });
    const snap = divergence.getSnapshot();
    expect(snap.trend).toHaveLength(2);
  });

  it('getSnapshot() includes all other dashboard snapshot fields', () => {
    const dash = makeDashboard();
    dash.recordTrendEntry();
    const divergence = makeDivergence(dash);
    const snap = divergence.getSnapshot();
    expect(snap.report).toBeDefined();
    expect(snap.mode).toBeDefined();
    expect(snap.gate).toBeDefined();
    expect(typeof snap.capturedAt).toBe('number');
  });

  it('getSnapshot() returns the most recent entries when slicing', () => {
    const dash = new DivergenceDashboard(makeSimulator(), 'warn-on-divergence', {
      maxTrendEntries: 10,
    });
    // Record 5 entries
    for (let i = 0; i < 5; i++) {
      dash.recordTrendEntry();
    }
    // With bufferLimit 3, we should get the last 3 (most recent)
    const divergence = new DivergencePanel(dash, { bufferLimit: 3 });
    const snapFull = dash.getSnapshot();
    const snapBuffered = divergence.getSnapshot();
    // Buffered trend should be the last 3 of the full trend
    expect(snapBuffered.trend).toEqual(snapFull.trend.slice(-3));
  });
});
