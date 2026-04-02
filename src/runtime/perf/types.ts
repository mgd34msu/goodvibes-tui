/**
 * Performance budget types for CI regression gates.
 *
 * Defines the contracts for budget definitions, collected metrics,
 * violations, and aggregated reports.
 */

/** Unit of measurement for a performance budget threshold. */
export type PerfUnit = 'ms' | 'bytes' | 'count' | 'percent';

/**
 * A performance budget defines an acceptable threshold for a named metric.
 * Violations are tracked consecutively; failure occurs when consecutiveViolations
 * exceeds the tolerance.
 */
export interface PerfBudget {
  /** Human-readable name for this budget. */
  name: string;
  /** The metric key this budget applies to. */
  metric: string;
  /** Acceptable upper bound for the metric value. */
  threshold: number;
  /** Unit of the threshold value. */
  unit: PerfUnit;
  /** Number of consecutive violations that triggers failure (e.g., 3 means fail on 3rd consecutive violation). */
  tolerance: number;
  /** Describes what this budget measures and why it matters. */
  description: string;
}

/**
 * A single performance metric sample collected at a point in time.
 */
export interface PerfMetric {
  /** The metric key (should match a PerfBudget.metric). */
  name: string;
  /** The sampled value. */
  value: number;
  /** Unit of the value. */
  unit: string;
  /** Unix epoch milliseconds when this sample was collected. */
  timestamp: number;
}

/**
 * A budget violation record, produced when a metric exceeds its threshold.
 */
export interface BudgetViolation {
  /** The budget that was violated. */
  budget: PerfBudget;
  /** The actual metric value that triggered the violation. */
  actual: number;
  /** How much the actual value exceeded the threshold (actual - threshold). */
  exceededBy: number;
  /** Number of consecutive samples that have violated this budget. */
  consecutiveViolations: number;
  /** Warning message when the metric was not found in the snapshot. */
  warning?: string;
}

/**
 * Aggregated performance report produced by a monitoring run.
 */
export interface PerfReport {
  /** Unix epoch milliseconds when this report was generated. */
  timestamp: number;
  /** All metrics collected during this monitoring run. */
  metrics: PerfMetric[];
  /** Violations where consecutiveViolations exceeds tolerance. */
  violations: BudgetViolation[];
  /** True if all budgets passed (no active violations). */
  passed: boolean;
}
