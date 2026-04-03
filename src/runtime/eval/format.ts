/**
 * Evaluation Harness — console formatting helpers.
 *
 * Provides formatSuiteResult() and formatGateResult() for console and
 * panel output. Kept separate from scorecard.ts to avoid circular imports.
 */

import type { EvalSuiteResult, EvalGateResult } from './types.ts';

const HR = '-'.repeat(72);

/**
 * Format an EvalSuiteResult as a multi-line string for console output.
 */
export function formatSuiteResult(result: EvalSuiteResult): string {
  const lines: string[] = [];
  const durationMs = result.finishedAt - result.startedAt;

  lines.push(HR);
  lines.push(`Suite: ${result.suite}`);
  lines.push(`Run:   ${new Date(result.startedAt).toISOString()}`);
  lines.push(`Time:  ${durationMs}ms  Scenarios: ${result.results.length}`);
  lines.push(`Mean Score: ${result.meanScore.toFixed(1)}/100  ${result.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(HR);

  for (const r of result.results) {
    const sc = r.scorecard;
    const flag = sc.passed ? 'PASS' : 'FAIL';
    lines.push(
      `  [${flag}] ${r.scenario.name.padEnd(44)} ${sc.compositeScore.toFixed(1).padStart(5)}/100`,
    );
  }

  lines.push(HR);
  return lines.join('\n');
}

/**
 * Format an EvalGateResult as a multi-line string.
 */
export function formatGateResult(gate: EvalGateResult): string {
  const lines: string[] = [];

  lines.push(HR);
  lines.push(`Gate: ${gate.suite}`);
  lines.push(`Result: ${gate.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(`Regression threshold: ${gate.regressionThreshold} points`);
  lines.push(
    `Baseline: ${gate.baseline ? `${gate.baseline.label} (${new Date(gate.baseline.capturedAt).toISOString()})` : 'none (first run)'}`,
  );
  lines.push(HR);

  if (gate.regressions.length > 0) {
    lines.push('Regressions:');
    for (const r of gate.regressions) {
      lines.push(
        `  ${r.scenarioName.slice(0, 44).padEnd(44)} ` +
        `baseline=${r.baselineScore.toFixed(1).padStart(5)} ` +
        `fresh=${r.freshScore.toFixed(1).padStart(5)} ` +
        `delta=${r.delta.toFixed(1).padStart(6)}`,
      );
    }
    lines.push(HR);
  } else if (gate.baseline) {
    lines.push('No regressions detected.');
    lines.push(HR);
  } else {
    lines.push('No baseline to compare against — this run will be saved as the new baseline.');
    lines.push(HR);
  }

  return lines.join('\n');
}
