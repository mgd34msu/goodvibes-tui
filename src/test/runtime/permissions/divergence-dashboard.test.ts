/**
 * GC-PERM-009 — Tests for DivergenceDashboard enforce gate and trend history.
 *
 * Covers:
 *   - checkEnforceGate(): no_data, allowed, blocked states
 *   - Gate blocks setMode('enforce') when divergence is too high
 *   - Gate allows setMode('enforce') when divergence is within threshold
 *   - recordTrendEntry(): accumulates history with correct fields
 *   - getTrend(): bounded FIFO array eviction
 *   - getSnapshot(): full snapshot shape
 *   - DivergenceGateError carries gate result
 *   - setMode() succeeds for non-enforce modes regardless of divergence
 */

import { describe, it, expect } from 'bun:test';
import { PermissionSimulator } from '../../../runtime/permissions/simulation.ts';
import {
  DivergenceDashboard,
  DivergenceGateError,
} from '../../../runtime/permissions/divergence-dashboard.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Creates a simulator preconfigured in warn-on-divergence mode. */
function makeSimulator() {
  // actual: allow-all; simulated: plan (blocks write/network)
  // This guarantees divergence on write tool calls.
  return new PermissionSimulator(
    { mode: 'allow-all' },
    { mode: 'plan' },
    'warn-on-divergence',
  );
}

/** Drive N evaluations through the simulator: `diverging` use a write tool. */
function drive(
  sim: PermissionSimulator,
  { total, diverging }: { total: number; diverging: number },
) {
  for (let i = 0; i < diverging; i++) {
    // write tool — allow-all allows, plan blocks → divergence
    sim.evaluate('write', { path: `/tmp/file-${i}.txt` });
  }
  for (let i = diverging; i < total; i++) {
    // read tool — both evaluators allow it
    sim.evaluate('read', { path: `/tmp/file-${i}.txt` });
  }
}

// ── Gate: no_data ─────────────────────────────────────────────────────────────

describe('DivergenceDashboard.checkEnforceGate() — no_data', () => {
  it('returns no_data when no evaluations have been recorded', () => {
    const sim = makeSimulator();
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence', {
      minEvaluationsForGate: 10,
    });
    const gate = dash.checkEnforceGate();
    expect(gate.status).toBe('no_data');
    expect(gate.divergenceRate).toBeUndefined();
    expect(gate.totalEvaluations).toBe(0);
  });

  it('returns no_data when fewer than minEvaluationsForGate evaluations recorded', () => {
    const sim = makeSimulator();
    drive(sim, { total: 5, diverging: 0 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence', {
      minEvaluationsForGate: 10,
    });
    const gate = dash.checkEnforceGate();
    expect(gate.status).toBe('no_data');
    expect(gate.totalEvaluations).toBe(5);
  });

  it('gate passes (no_data → allowed for setMode) when below min evals', () => {
    const sim = makeSimulator();
    const dash = new DivergenceDashboard(sim, 'simulation-only', {
      minEvaluationsForGate: 10,
    });
    // Should NOT throw even in enforce mode (no_data = passes by default)
    expect(() => dash.setMode('enforce')).not.toThrow();
  });
});

// ── Gate: allowed ─────────────────────────────────────────────────────────────

describe('DivergenceDashboard.checkEnforceGate() — allowed', () => {
  it('returns allowed when divergence rate is within threshold', () => {
    const sim = makeSimulator();
    // 1 divergence in 100 evals → 1% < default 5%
    drive(sim, { total: 100, diverging: 1 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    const gate = dash.checkEnforceGate();
    expect(gate.status).toBe('allowed');
    expect(gate.divergenceRate).toBeDefined();
    expect(gate.divergenceRate!).toBeLessThanOrEqual(0.05);
    expect(gate.message).toContain('Gate passing');
  });

  it('allows setMode("enforce") when gate is passing', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 1 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    expect(() => dash.setMode('enforce')).not.toThrow();
    expect(dash.getMode()).toBe('enforce');
  });

  it('allows setMode("enforce") exactly at threshold', () => {
    const sim = makeSimulator();
    // Exactly 5 divergences in 100 evals → 5% == threshold, not > threshold
    drive(sim, { total: 100, diverging: 5 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence', {
      threshold: 0.05,
    });
    const gate = dash.checkEnforceGate();
    expect(gate.status).toBe('allowed');
    expect(() => dash.setMode('enforce')).not.toThrow();
  });
});

// ── Gate: blocked ─────────────────────────────────────────────────────────────

describe('DivergenceDashboard.checkEnforceGate() — blocked', () => {
  it('returns blocked when divergence rate exceeds threshold', () => {
    const sim = makeSimulator();
    // 20 divergences in 100 evals → 20% > 5%
    drive(sim, { total: 100, diverging: 20 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    const gate = dash.checkEnforceGate();
    expect(gate.status).toBe('blocked');
    expect(gate.divergenceRate).toBeGreaterThan(0.05);
    expect(gate.message).toContain('blocked');
  });

  it('blocks setMode("enforce") and throws DivergenceGateError', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 20 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    expect(() => dash.setMode('enforce')).toThrow(DivergenceGateError);
  });

  it('DivergenceGateError carries the gate result', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 20 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    let caught: DivergenceGateError | undefined;
    try {
      dash.setMode('enforce');
    } catch (e) {
      caught = e as DivergenceGateError;
    }
    expect(caught).toBeDefined();
    expect(caught!.name).toBe('DivergenceGateError');
    expect(caught!.gate.status).toBe('blocked');
    expect(caught!.gate.divergenceRate).toBeGreaterThan(0.05);
    expect(caught!.gate.threshold).toBe(0.05);
  });

  it('does not change mode when setMode("enforce") is blocked', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 20 });
    const dash = new DivergenceDashboard(sim, 'simulation-only');
    try {
      dash.setMode('enforce');
    } catch {
      // expected
    }
    expect(dash.getMode()).toBe('simulation-only');
  });

  it('respects custom threshold', () => {
    const sim = makeSimulator();
    // 3 divergences in 100 evals → 3% > custom 2% threshold
    drive(sim, { total: 100, diverging: 3 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence', {
      threshold: 0.02,
    });
    expect(dash.checkEnforceGate().status).toBe('blocked');
    expect(() => dash.setMode('enforce')).toThrow(DivergenceGateError);
  });
});

// ── setMode — non-enforce modes always succeed ─────────────────────────────────

describe('DivergenceDashboard.setMode() — non-enforce modes', () => {
  it('allows transitioning to simulation-only regardless of divergence', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 50 }); // 50% divergence
    const dash = new DivergenceDashboard(sim, 'enforce');
    expect(() => dash.setMode('simulation-only')).not.toThrow();
    expect(dash.getMode()).toBe('simulation-only');
  });

  it('allows transitioning to warn-on-divergence regardless of divergence', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 50 });
    const dash = new DivergenceDashboard(sim, 'enforce');
    expect(() => dash.setMode('warn-on-divergence')).not.toThrow();
    expect(dash.getMode()).toBe('warn-on-divergence');
  });
});

// ── Trend history ─────────────────────────────────────────────────────────────

describe('DivergenceDashboard.recordTrendEntry() / getTrend()', () => {
  it('returns empty trend initially', () => {
    const sim = makeSimulator();
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    expect(dash.getTrend()).toHaveLength(0);
  });

  it('records one entry per call', () => {
    const sim = makeSimulator();
    drive(sim, { total: 20, diverging: 2 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    dash.recordTrendEntry();
    dash.recordTrendEntry();
    dash.recordTrendEntry();
    expect(dash.getTrend()).toHaveLength(3);
  });

  it('trend entry has correct shape', () => {
    const sim = makeSimulator();
    drive(sim, { total: 20, diverging: 2 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    const entry = dash.recordTrendEntry();
    expect(typeof entry.ts).toBe('number');
    expect(entry.totalEvaluations).toBe(20);
    expect(entry.totalDivergences).toBe(2);
    expect(typeof entry.divergenceRate).toBe('number');
    expect(typeof entry.gatePassing).toBe('boolean');
  });

  it('trend entry gatePassing=false when divergence exceeds threshold', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 20 }); // 20% > 5%
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    const entry = dash.recordTrendEntry();
    expect(entry.gatePassing).toBe(false);
  });

  it('trend entry gatePassing=true when divergence is within threshold', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 1 }); // 1% < 5%
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    const entry = dash.recordTrendEntry();
    expect(entry.gatePassing).toBe(true);
  });

  it('evicts oldest entries when maxTrendEntries is exceeded', () => {
    const sim = makeSimulator();
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence', {
      maxTrendEntries: 3,
    });
    for (let i = 0; i < 5; i++) {
      dash.recordTrendEntry();
    }
    expect(dash.getTrend()).toHaveLength(3);
  });

  it('getTrend returns a copy (mutations do not affect internal buffer)', () => {
    const sim = makeSimulator();
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    dash.recordTrendEntry();
    const trend = dash.getTrend() as unknown[];
    trend.length = 0;
    expect(dash.getTrend()).toHaveLength(1);
  });
});

// ── getSnapshot ───────────────────────────────────────────────────────────────

describe('DivergenceDashboard.getSnapshot()', () => {
  it('returns a snapshot with all required fields', () => {
    const sim = makeSimulator();
    drive(sim, { total: 20, diverging: 1 });
    const dash = new DivergenceDashboard(sim, 'warn-on-divergence');
    dash.recordTrendEntry();
    const snap = dash.getSnapshot();
    expect(snap.report).toBeDefined();
    expect(snap.mode).toBe('warn-on-divergence');
    expect(snap.gate).toBeDefined();
    expect(snap.trend).toHaveLength(1);
    expect(typeof snap.capturedAt).toBe('number');
  });

  it('snapshot reflects updated mode after setMode()', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 1 });
    const dash = new DivergenceDashboard(sim, 'simulation-only');
    dash.setMode('warn-on-divergence');
    const snap = dash.getSnapshot();
    expect(snap.mode).toBe('warn-on-divergence');
  });
});

// ── isGatePassing ─────────────────────────────────────────────────────────────

describe('DivergenceDashboard.isGatePassing()', () => {
  it('returns true when gate is no_data', () => {
    const sim = makeSimulator();
    const dash = new DivergenceDashboard(sim, 'simulation-only', {
      minEvaluationsForGate: 10,
    });
    expect(dash.isGatePassing()).toBe(true);
  });

  it('returns true when gate is allowed', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 1 });
    const dash = new DivergenceDashboard(sim, 'simulation-only');
    expect(dash.isGatePassing()).toBe(true);
  });

  it('returns false when gate is blocked', () => {
    const sim = makeSimulator();
    drive(sim, { total: 100, diverging: 20 });
    const dash = new DivergenceDashboard(sim, 'simulation-only');
    expect(dash.isGatePassing()).toBe(false);
  });
});

