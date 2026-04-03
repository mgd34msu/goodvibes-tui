/**
 * GC-PERM-009 — Divergence Dashboard and Enforcement Gate.
 *
 * Wraps a `PermissionSimulator` to provide:
 *   - Trend history: periodic snapshots of divergence rates bucketed by time.
 *   - Enforce gate: prevents transitioning to `enforce` mode when the
 *     divergence rate exceeds the configured threshold.
 *   - Aggregated dashboard data queryable by the diagnostics layer.
 *
 * The dashboard is passive — it reads from the simulator, does not own
 * the simulator's lifecycle, and never calls evaluate() itself.
 *
 * @remarks
 * Pre-positioned for feature-flag-gated production integration.
 * When the `diagnostics.divergencePanel` feature flag is enabled, this
 * dashboard is wired into the session emitter pipeline (same pattern as
 * session emitters in GC-ARCH-002). Until that flag is active, this module
 * is exercised only via `DivergencePanel` in the diagnostics layer.
 */

import type {
  DivergenceReport,
  SimulationMode,
} from './types.ts';
import type { PermissionSimulator } from './simulation.ts';

// ── Trend types ───────────────────────────────────────────────────────────────

/**
 * A single time-bucketed snapshot of divergence statistics.
 *
 * Captured periodically by `DivergenceDashboard` and stored in a bounded
 * FIFO array to provide trend history for UI display.
 */
export interface DivergenceTrendEntry {
  /** Unix epoch milliseconds when this snapshot was taken. */
  readonly ts: number;
  /** Overall divergence rate at the time of the snapshot (0–1). */
  readonly divergenceRate: number;
  /** Total evaluations recorded up to this point. */
  readonly totalEvaluations: number;
  /** Total divergences recorded up to this point. */
  readonly totalDivergences: number;
  /** Whether the gate was passing at the time of the snapshot. */
  readonly gatePassing: boolean;
}

/**
 * Gate check result returned by `DivergenceDashboard.checkEnforceGate()`.
 *
 * - `allowed`  — divergence is within threshold; enforce mode may be enabled.
 * - `blocked`  — divergence exceeds threshold; enforce mode is blocked.
 * - `no_data`  — not enough evaluations have been recorded to make a
 *                determination; gate passes by default.
 */
export type EnforceGateStatus = 'allowed' | 'blocked' | 'no_data';

/**
 * Full result of an enforce gate check.
 */
export interface EnforceGateResult {
  /** Whether enforce mode transition is permitted. */
  readonly status: EnforceGateStatus;
  /** Current divergence rate (0–1). Undefined when status is `no_data`. */
  readonly divergenceRate?: number;
  /** Configured threshold (0–1). */
  readonly threshold: number;
  /** Total evaluations at the time of the check. */
  readonly totalEvaluations: number;
  /** Human-readable explanation of the result. */
  readonly message: string;
}

/**
 * Full dashboard snapshot returned by `DivergenceDashboard.getSnapshot()`.
 *
 * Combines the current divergence report with trend history and gate status.
 */
export interface DivergenceDashboardSnapshot {
  /** Current divergence report from the simulator. */
  readonly report: DivergenceReport;
  /** Active simulation mode at the time of the snapshot. */
  readonly mode: SimulationMode;
  /** Current enforce gate result. */
  readonly gate: EnforceGateResult;
  /** Trend history (oldest first). */
  readonly trend: readonly DivergenceTrendEntry[];
  /** Epoch ms when this snapshot was taken. */
  readonly capturedAt: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Configuration for `DivergenceDashboard`.
 */
export interface DivergenceDashboardConfig {
  /**
   * Maximum divergence rate (0–1) before enforce mode is blocked.
   * Defaults to 0.05 (5%).
   */
  threshold?: number;
  /**
   * Minimum number of evaluations required before the gate makes a
   * `blocked` determination. Below this count the gate returns `no_data`.
   * Defaults to 10.
   */
  minEvaluationsForGate?: number;
  /**
   * Maximum number of trend entries to retain in the bounded FIFO array.
   * Defaults to 100.
   */
  maxTrendEntries?: number;
}

// ── DivergenceDashboard ───────────────────────────────────────────────────────

/**
 * DivergenceDashboard — divergence monitoring and enforce-mode gate.
 *
 * Attach to a running `PermissionSimulator` to gain:
 *   - `checkEnforceGate()` — real-time gate check before mode transitions.
 *   - `recordTrendEntry()` — capture a snapshot for trend history.
 *   - `getSnapshot()` — full dashboard state for diagnostics rendering.
 *
 * @example
 * ```ts
 * const simulator = createPermissionSimulator(actual, simulated, 'warn-on-divergence');
 * const dashboard = new DivergenceDashboard(simulator, 'warn-on-divergence');
 *
 * // Periodically capture trend entries (e.g. every 30 seconds):
 * setInterval(() => dashboard.recordTrendEntry(), 30_000);
 *
 * // Before switching to enforce mode:
 * const gate = dashboard.checkEnforceGate();
 * if (gate.status !== 'allowed') {
 *   console.error('Enforce blocked:', gate.message);
 * }
 * ```
 */
export class DivergenceDashboard {
  private readonly _simulator: PermissionSimulator;
  /**
   * @remarks
   * Dashboard-layer mode for UI display only. Independent of the immutable
   * simulator mode — the underlying `PermissionSimulator` mode is fixed at
   * construction and cannot be changed. `_mode` tracks the caller's intended
   * operational state so the diagnostics view can render it accurately.
   */
  private _mode: SimulationMode;
  private readonly _threshold: number;
  private readonly _minEvals: number;
  private readonly _maxTrendEntries: number;
  private readonly _trend: DivergenceTrendEntry[] = [];

  private static readonly DEFAULT_THRESHOLD = 0.05;
  private static readonly DEFAULT_MIN_EVALS = 10;
  private static readonly DEFAULT_MAX_TREND = 100;

  constructor(
    simulator: PermissionSimulator,
    mode: SimulationMode,
    config: DivergenceDashboardConfig = {},
  ) {
    this._simulator = simulator;
    this._mode = mode;
    this._threshold = config.threshold ?? DivergenceDashboard.DEFAULT_THRESHOLD;
    this._minEvals = config.minEvaluationsForGate ?? DivergenceDashboard.DEFAULT_MIN_EVALS;
    this._maxTrendEntries = config.maxTrendEntries ?? DivergenceDashboard.DEFAULT_MAX_TREND;
  }

  /**
   * checkEnforceGate — Checks whether transitioning to `enforce` mode is safe.
   *
   * Returns `no_data` when fewer than `minEvaluationsForGate` evaluations have
   * been recorded (gate passes by default in this case).
   * Returns `blocked` when the overall divergence rate exceeds the threshold.
   * Returns `allowed` otherwise.
   */
  checkEnforceGate(): EnforceGateResult {
    const report = this._simulator.getDivergenceReport();
    return this._computeGate(report.overall);
  }

  /** @internal Compute gate result from pre-fetched stats to avoid double getDivergenceReport() calls. */
  private _computeGate({ totalEvaluations, divergenceRate }: { totalEvaluations: number; divergenceRate: number }): EnforceGateResult {
    if (totalEvaluations < this._minEvals) {
      return {
        status: 'no_data',
        threshold: this._threshold,
        totalEvaluations,
        message:
          `Insufficient data: ${totalEvaluations}/${this._minEvals} minimum evaluations recorded. ` +
          `Gate passes by default.`,
      };
    }

    if (divergenceRate > this._threshold) {
      return {
        status: 'blocked',
        divergenceRate,
        threshold: this._threshold,
        totalEvaluations,
        message:
          `Enforce mode blocked: divergence rate ${(divergenceRate * 100).toFixed(2)}% ` +
          `exceeds threshold ${(this._threshold * 100).toFixed(2)}%. ` +
          `Reduce divergence or increase threshold before enabling enforce mode.`,
      };
    }

    return {
      status: 'allowed',
      divergenceRate,
      threshold: this._threshold,
      totalEvaluations,
      message:
        `Gate passing: divergence rate ${(divergenceRate * 100).toFixed(2)}% ` +
        `is within threshold ${(this._threshold * 100).toFixed(2)}%.`,
    };
  }

  /**
   * recordTrendEntry — Captures a snapshot of the current divergence state.
   *
   * Call periodically (e.g. on a timer) to build trend history.
   * Oldest entries are evicted when the buffer exceeds `maxTrendEntries`.
   */
  recordTrendEntry(): DivergenceTrendEntry {
    const report = this._simulator.getDivergenceReport();
    const overall = report.overall;
    const gate = this._computeGate(report.overall);

    const entry: DivergenceTrendEntry = {
      ts: Date.now(),
      divergenceRate: overall.divergenceRate,
      totalEvaluations: overall.totalEvaluations,
      totalDivergences: overall.total,
      gatePassing: gate.status !== 'blocked',
    };

    if (this._trend.length >= this._maxTrendEntries) {
      this._trend.shift();
    }
    this._trend.push(entry);

    return entry;
  }

  /**
   * getTrend — Returns the full trend history (oldest first).
   */
  getTrend(): readonly DivergenceTrendEntry[] {
    return [...this._trend];
  }

  /**
   * getSnapshot — Returns a full dashboard snapshot for diagnostics rendering.
   */
  getSnapshot(): DivergenceDashboardSnapshot {
    const report = this._simulator.getDivergenceReport();
    return {
      report,
      mode: this._mode,
      gate: this._computeGate(report.overall),
      trend: this.getTrend(),
      capturedAt: Date.now(),
    };
  }

  /**
   * setMode — Updates the tracked simulation mode.
   *
   * Does NOT modify the underlying simulator (which has an immutable mode).
   * This is for dashboard display purposes when the caller manages mode
   * transitions externally.
   *
   * Throws if an attempt is made to set `enforce` mode while the gate is
   * `blocked`. This is the primary enforcement mechanism for GC-PERM-009.
   *
   * @throws {DivergenceGateError} when attempting to enable enforce mode
   *   while divergence exceeds the configured threshold.
   */
  setMode(mode: SimulationMode): void {
    if (mode === 'enforce') {
      const gate = this.checkEnforceGate();
      if (gate.status === 'blocked') {
        throw new DivergenceGateError(gate.message, gate);
      }
    }
    this._mode = mode;
  }

  /**
   * getMode — Returns the currently tracked simulation mode.
   */
  getMode(): SimulationMode {
    return this._mode;
  }

  /**
   * getThreshold — Returns the configured divergence threshold.
   */
  getThreshold(): number {
    return this._threshold;
  }

  /**
   * isGatePassing — Convenience accessor; true unless gate is `blocked`.
   */
  isGatePassing(): boolean {
    return this.checkEnforceGate().status !== 'blocked';
  }
}

// ── DivergenceGateError ───────────────────────────────────────────────────────

/**
 * Thrown by `DivergenceDashboard.setMode('enforce')` when the divergence
 * gate is in `blocked` state.
 */
export class DivergenceGateError extends Error {
  /** The full gate result at the time the error was thrown. */
  readonly gate: EnforceGateResult;

  constructor(message: string, gate: EnforceGateResult) {
    super(message);
    this.name = 'DivergenceGateError';
    this.gate = gate;
  }
}
