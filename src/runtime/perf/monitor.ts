/**
 * PerfMonitor — collects metrics from the runtime store and evaluates
 * them against registered performance budgets.
 *
 * The monitor maintains a violation streak counter per budget so that
 * transient spikes do not trip CI; only sustained regressions fail.
 */

import type { UiPerfDomainState } from '../store/domains/ui-perf.ts';
import type {
  PerfBudget,
  PerfMetric,
  BudgetViolation,
  PerfReport,
} from './types.ts';
import { DEFAULT_BUDGETS } from './budgets.ts';

/**
 * Snapshot of runtime state provided to the monitor for metric extraction.
 * Callers supply this from the store or from test fixtures.
 */
export interface PerfSnapshot {
  /** Current UI performance domain state. */
  uiPerf: UiPerfDomainState;
  /**
   * Optional additional metric overrides keyed by metric name.
   * Useful for injecting tool executor or compaction metrics from
   * other subsystems that are not yet reflected in the store domain.
   */
  extraMetrics?: Record<string, number>;
}

/**
 * Computes the 95th percentile from a numeric array.
 * Returns 0 for empty arrays.
 */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * PerfMonitor collects metrics from a runtime snapshot, evaluates them
 * against a set of performance budgets, and tracks consecutive violation
 * streaks per budget.
 *
 * @example
 * ```ts
 * const monitor = new PerfMonitor();
 * const report = monitor.evaluate(snapshot);
 * if (!report.passed) process.exit(1);
 * ```
 */
export class PerfMonitor {
  private readonly budgets: PerfBudget[];
  /** Maps budget metric name to number of consecutive violations. */
  private readonly streaks: Map<string, number> = new Map();
  /** Heap snapshot from the previous evaluation, used to compute growth delta. */
  private _previousHeapUsedBytes: number = 0;

  constructor(budgets: PerfBudget[] = DEFAULT_BUDGETS) {
    this.budgets = budgets;
  }

  /**
   * Extracts PerfMetrics from a PerfSnapshot.
   *
   * Metrics derived from UiPerfDomainState:
   * - frame.render.p95 — p95 of recentCycles.durationMs
   * - memory.growth.bytes_per_hour — heap growth rate since previous evaluate()
   *
   * Metrics from extraMetrics (pass-through):
   * - event.queue.depth
   * - tool.executor.overhead.p95
   * - compaction.latency.p95
   */
  private extractMetrics(snapshot: PerfSnapshot, now: number): PerfMetric[] {
    const { uiPerf, extraMetrics = {} } = snapshot;
    const metrics: PerfMetric[] = [];

    // Frame render p95
    const renderDurations = uiPerf.recentCycles.map((c) => c.durationMs);
    metrics.push({
      name: 'frame.render.p95',
      value: p95(renderDurations),
      unit: 'ms',
      timestamp: now,
    });

    // Memory growth rate: extrapolate bytes/hour from heap delta since last evaluate().
    // If no prior sample is available, fall back to 0 (can't compute rate).
    const lastSampleAge =
      uiPerf.lastMemorySampleAt !== undefined
        ? now - uiPerf.lastMemorySampleAt
        : 0;
    const heapDelta = uiPerf.heapUsedBytes - this._previousHeapUsedBytes;
    const bytesPerHour =
      lastSampleAge > 0 ? (heapDelta / lastSampleAge) * 3_600_000 : 0;
    this._previousHeapUsedBytes = uiPerf.heapUsedBytes;
    metrics.push({
      name: 'memory.growth.bytes_per_hour',
      value: bytesPerHour,
      unit: 'bytes',
      timestamp: now,
    });

    // Pass-through extra metrics
    for (const [metricName, value] of Object.entries(extraMetrics)) {
      const budget = this.budgets.find((b) => b.metric === metricName);
      metrics.push({
        name: metricName,
        value,
        unit: budget?.unit ?? 'count',
        timestamp: now,
      });
    }

    return metrics;
  }

  /**
   * Evaluates the given snapshot against all registered budgets.
   * Updates internal violation streak counters.
   *
   * @param snapshot - Runtime state snapshot to evaluate.
   * @returns A PerfReport summarising metrics and active violations.
   */
  evaluate(snapshot: PerfSnapshot): PerfReport {
    const now = Date.now();
    const metrics = this.extractMetrics(snapshot, now);
    const violations: BudgetViolation[] = [];

    for (const budget of this.budgets) {
      const metric = metrics.find((m) => m.name === budget.metric);
      if (!metric) {
        // Metric not found — add a warning entry instead of silently passing
        violations.push({
          budget,
          actual: NaN,
          exceededBy: NaN,
          consecutiveViolations: 0,
          warning: `Metric '${budget.metric}' not found in snapshot`,
        });
        continue;
      }

      const actual = metric.value;

      if (actual > budget.threshold) {
        const prev = this.streaks.get(budget.metric) ?? 0;
        const consecutiveViolations = prev + 1;
        this.streaks.set(budget.metric, consecutiveViolations);

        if (consecutiveViolations >= budget.tolerance) {
          violations.push({
            budget,
            actual,
            exceededBy: actual - budget.threshold,
            consecutiveViolations,
          });
        }
      } else {
        // Reset streak on passing sample
        this.streaks.set(budget.metric, 0);
      }
    }

    return {
      timestamp: now,
      metrics,
      violations,
      passed: violations.length === 0,
    };
  }

  /** Resets all violation streak counters. */
  reset(): void {
    this.streaks.clear();
  }

  /** Returns the current violation streak for a given metric, or 0. */
  streak(metric: string): number {
    return this.streaks.get(metric) ?? 0;
  }
}
