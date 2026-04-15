/**
 * perf-check.ts — CI performance budget gate.
 *
 * Runs the performance monitor against a synthetic snapshot derived
 * from the current runtime state (or a zero-state fixture in CI where
 * no live runtime is available). Outputs a formatted budget report and
 * exits non-zero if any budget is violated beyond its tolerance.
 *
 * Usage:
 *   bun run scripts/perf-check.ts
 *
 * Exit codes:
 *   0 — all budgets passed
 *   1 — one or more budgets exceeded tolerance
 */

import { createPerfMonitor, formatReport, exitCode } from '../src/runtime/perf/index.ts';
import { createInitialUiPerfState } from '../src/runtime/store/domains/ui-perf.ts';
import type { PerfSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/perf/monitor';

/**
 * Builds a PerfSnapshot for use in CI.
 *
 * In a live runtime, this would read from the Zustand store. In CI,
 * we use the initial (zero) state which represents an idle runtime;
 * this validates that the budget infrastructure itself works and that
 * no budgets are configured with thresholds below zero.
 *
 * For regression testing against recorded sessions, replace this with
 * a loader that reads a captured metrics JSON file.
 */
function buildCiSnapshot(): PerfSnapshot {
  const uiPerf = createInitialUiPerfState();

  // Simulate a minimal set of extra metrics that are not yet captured
  // by the UiPerfDomainState but must be present for full budget evaluation.
  // In CI these default to 0 (no load). Regression tests should inject
  // realistic values recorded from live sessions.
  const extraMetrics: Record<string, number> = {
    'event.queue.depth': 0,
    'tool.executor.overhead.p95': 0,
    'compaction.latency.p95': 0,
    'slo.turn_start.p95': 0,
    'slo.cancel.p95': 0,
    'slo.reconnect_recovery.p95': 0,
    'slo.permission_decision.p95': 0,
    'slo.integration.delivery_success_rate': 1,
    'slo.integration.dlq_depth': 0,
  };

  return { uiPerf, extraMetrics };
}

/**
 * Main entry point.
 */
function main(): void {
  const monitor = createPerfMonitor();
  const snapshot = buildCiSnapshot();

  // Run a single evaluation pass
  const report = monitor.evaluate(snapshot);

  // Print formatted table to stdout
  process.stdout.write(formatReport(report));

  // Exit with appropriate code for CI
  process.exit(exitCode(report));
}

main();
