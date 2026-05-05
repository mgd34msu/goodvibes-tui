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

function makePanel(dash?: DivergenceDashboard) {
  return new DivergencePanel(dash ?? makeDashboard());
}

// ── subscribe / notify lifecycle ──────────────────────────────────────────────

describe('DivergencePanel — subscribe / notify', () => {
  it('calls subscriber when recordTrendEntry is invoked', () => {
    const panel = makePanel();
    const cb = mock(() => {});
    panel.subscribe(cb);
    panel.recordTrendEntry();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('calls multiple subscribers on each recordTrendEntry', () => {
    const panel = makePanel();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    panel.subscribe(cb1);
    panel.subscribe(cb2);
    panel.recordTrendEntry();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('calls subscriber on each subsequent recordTrendEntry call', () => {
    const panel = makePanel();
    const cb = mock(() => {});
    panel.subscribe(cb);
    panel.recordTrendEntry();
    panel.recordTrendEntry();
    panel.recordTrendEntry();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('does not call subscriber before any recordTrendEntry', () => {
    const panel = makePanel();
    const cb = mock(() => {});
    panel.subscribe(cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── unsubscribe ───────────────────────────────────────────────────────────────

describe('DivergencePanel — unsubscribe', () => {
  it('unsubscribe removes the listener', () => {
    const panel = makePanel();
    const cb = mock(() => {});
    const unsub = panel.subscribe(cb);
    unsub();
    panel.recordTrendEntry();
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe of one does not affect other subscribers', () => {
    const panel = makePanel();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    const unsub1 = panel.subscribe(cb1);
    panel.subscribe(cb2);
    unsub1();
    panel.recordTrendEntry();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('calling unsubscribe twice is safe', () => {
    const panel = makePanel();
    const cb = mock(() => {});
    const unsub = panel.subscribe(cb);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ── dispose ───────────────────────────────────────────────────────────────────

describe('DivergencePanel — dispose', () => {
  it('dispose() clears all subscribers', () => {
    const panel = makePanel();
    const cb1 = mock(() => {});
    const cb2 = mock(() => {});
    panel.subscribe(cb1);
    panel.subscribe(cb2);
    panel.dispose();
    panel.recordTrendEntry();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('dispose() is safe to call when no subscribers are registered', () => {
    const panel = makePanel();
    expect(() => panel.dispose()).not.toThrow();
  });

  it('dispose() is safe to call multiple times', () => {
    const panel = makePanel();
    const cb = mock(() => {});
    panel.subscribe(cb);
    panel.dispose();
    expect(() => panel.dispose()).not.toThrow();
  });
});

// ── error handling in _notify ─────────────────────────────────────────────────

describe('DivergencePanel — subscriber error handling', () => {
  it('a throwing subscriber does not crash the panel', async () => {
    const panel = makePanel();
    panel.subscribe(() => {
      throw new Error('subscriber failure');
    });
    expect(() => panel.recordTrendEntry()).not.toThrow();
    await flushMicrotasks();
  });

  it('subsequent subscribers are still called when an earlier one throws', async () => {
    const panel = makePanel();
    const cb = mock(() => {});
    panel.subscribe(() => {
      throw new Error('boom');
    });
    panel.subscribe(cb);
    panel.recordTrendEntry();
    await flushMicrotasks();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── getSnapshot bufferLimit slicing ───────────────────────────────────────────

describe('DivergencePanel — getSnapshot() bufferLimit', () => {
  it('getSnapshot() trend is capped at bufferLimit', () => {
    const dash = makeDashboard();
    // Record 5 trend entries in the dashboard
    for (let i = 0; i < 5; i++) {
      dash.recordTrendEntry();
    }
    // Panel with bufferLimit of 3 should only expose 3 entries
    const panel = new DivergencePanel(dash, { bufferLimit: 3 });
    const snap = panel.getSnapshot();
    expect(snap.trend).toHaveLength(3);
  });

  it('getSnapshot() trend is not truncated when trend length is within bufferLimit', () => {
    const dash = makeDashboard();
    dash.recordTrendEntry();
    dash.recordTrendEntry();
    const panel = new DivergencePanel(dash, { bufferLimit: 10 });
    const snap = panel.getSnapshot();
    expect(snap.trend).toHaveLength(2);
  });

  it('getSnapshot() includes all other dashboard snapshot fields', () => {
    const dash = makeDashboard();
    dash.recordTrendEntry();
    const panel = makePanel(dash);
    const snap = panel.getSnapshot();
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
    const panel = new DivergencePanel(dash, { bufferLimit: 3 });
    const snapFull = dash.getSnapshot();
    const snapPanel = panel.getSnapshot();
    // Panel trend should be the last 3 of the full trend
    expect(snapPanel.trend).toEqual(snapFull.trend.slice(-3));
  });
});
