/**
 * Performance budget system — barrel export.
 *
 * Provides budget definitions, the PerfMonitor class for metric collection
 * and budget evaluation, and the reporter for CI/console output.
 *
 * @example
 * ```ts
 * import { createPerfMonitor, DEFAULT_BUDGETS } from './perf/index.ts';
 *
 * const monitor = createPerfMonitor();
 * const report = monitor.evaluate(snapshot);
 * ```
 */

export type {
  PerfBudget,
  PerfMetric,
  BudgetViolation,
  PerfReport,
  PerfUnit,
} from './types.ts';

export { DEFAULT_BUDGETS } from './budgets.ts';
export { PerfMonitor } from './monitor.ts';
export type { PerfSnapshot } from './monitor.ts';
export { formatReport, exitCode } from './reporter.ts';
export { SloCollector, SLO_METRICS } from './slo-collector.ts';
export type {
  PanelResourceContract,
  PanelHealthState,
  PanelThrottleStatus,
  PanelHealthStatus,
} from './panel-contracts.ts';
export {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialPanelHealthState,
} from './panel-contracts.ts';
export {
  PanelHealthMonitor,
  getSharedPanelHealthMonitor,
  resetSharedPanelHealthMonitor,
} from './panel-health-monitor.ts';

import { PerfMonitor } from './monitor.ts';
import type { PerfBudget } from './types.ts';
import { DEFAULT_BUDGETS } from './budgets.ts';

/**
 * Factory function that creates a PerfMonitor with the default budgets.
 * Pass a custom budgets array to override defaults.
 *
 * @param budgets - Optional custom budget definitions.
 * @returns A new PerfMonitor instance ready for evaluation.
 */
export function createPerfMonitor(budgets: PerfBudget[] = DEFAULT_BUDGETS): PerfMonitor {
  return new PerfMonitor(budgets);
}
