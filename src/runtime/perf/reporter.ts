/**
 * PerfReporter — formats a PerfReport as a human-readable console table
 * and provides an exit code for CI integration.
 */

import type { PerfReport, PerfMetric, BudgetViolation, PerfBudget } from './types.ts';

/** Column widths for the console table. */
const COL = {
  metric: 40,
  value: 16,
  threshold: 16,
  status: 10,
} as const;

/** Right-pads a string to the given width. */
function pad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

/** Formats a numeric value with its unit for display. */
function formatValue(value: number, unit: string): string {
  if (unit === 'bytes') {
    const mib = value / (1024 * 1024);
    return `${mib.toFixed(1)} MiB/hr`;
  }
  if (unit === 'ms') return `${value.toFixed(2)} ms`;
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  return `${value}`;
}

/**
 * Builds a console-printable table row for a metric.
 */
function metricRow(
  metric: PerfMetric,
  threshold: number,
  unit: string,
  violated: boolean,
): string {
  const status = violated ? 'FAIL' : 'ok';
  return [
    pad(metric.name, COL.metric),
    pad(formatValue(metric.value, unit), COL.value),
    pad(formatValue(threshold, unit), COL.threshold),
    pad(status, COL.status),
  ].join(' | ');
}

/**
 * Formats a PerfReport as a multi-line string suitable for console output.
 * Includes a header, per-metric rows, a summary, and violation details.
 */
export function formatReport(report: PerfReport): string {
  const lines: string[] = [];
  const hr = '-'.repeat(COL.metric + COL.value + COL.threshold + COL.status + 9); // 3 column separators × 3 chars each (" | ")

  lines.push('');
  lines.push('Performance Budget Report');
  lines.push(new Date(report.timestamp).toISOString());
  lines.push(hr);
  lines.push(
    [
      pad('Metric', COL.metric),
      pad('Actual', COL.value),
      pad('Budget', COL.threshold),
      pad('Status', COL.status),
    ].join(' | '),
  );
  lines.push(hr);

  // Index violations by metric name for O(1) lookup
  const violatedMetrics = new Set(
    report.violations.map((v: BudgetViolation) => v.budget.metric),
  );

  for (const metric of report.metrics) {
    // Prefer violation budget info; fall back to DEFAULT_BUDGETS for passing metrics
    const violation = report.violations.find(
      (v: BudgetViolation) => v.budget.metric === metric.name,
    );
    const knownBudget: PerfBudget | undefined =
      violation?.budget ??
      report.violations.find((v: BudgetViolation) => v.budget.metric === metric.name)?.budget;
    const threshold = knownBudget?.threshold ?? Infinity;
    const unit = knownBudget?.unit ?? metric.unit;
    lines.push(metricRow(metric, threshold, unit, violatedMetrics.has(metric.name)));
  }

  lines.push(hr);

  if (report.passed) {
    lines.push('Result: PASSED — all budgets within tolerance');
  } else {
    lines.push(`Result: FAILED — ${report.violations.length} budget(s) exceeded tolerance`);
    lines.push('');
    lines.push('Violations:');
    for (const v of report.violations) {
      if (v.warning) {
        lines.push(`  ${v.budget.name}: WARNING — ${v.warning}`);
      } else {
        lines.push(
          `  ${v.budget.name}: actual=${formatValue(v.actual, v.budget.unit)} ` +
            `budget=${formatValue(v.budget.threshold, v.budget.unit)} ` +
            `exceeded_by=${formatValue(v.exceededBy, v.budget.unit)} ` +
            `consecutive=${v.consecutiveViolations}/${v.budget.tolerance}`,
        );
      }
      lines.push(`    ${v.budget.description}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Returns the appropriate process exit code for a report.
 * 0 = all budgets passed; 1 = one or more violated.
 */
export function exitCode(report: PerfReport): number {
  return report.passed ? 0 : 1;
}
