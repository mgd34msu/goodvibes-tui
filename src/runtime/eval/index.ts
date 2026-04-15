/**
 * Evaluation Harness — barrel export.
 *
 * Provides the eval runner, scorecard scorer, built-in suites,
 * and baseline persistence utilities.
 *
 * @example
 * ```ts
 * import { EvalRunner, BUILTIN_SUITES, captureBaseline, loadBaseline } from './eval/index.ts';
 *
 * const runner = new EvalRunner();
 * const result = await runner.runSuite('core-performance', BUILTIN_SUITES['core-performance']);
 * const gate = runner.evaluateGate(result, await loadBaseline('.goodvibes/eval/baseline.json'));
 * if (!gate.passed) process.exit(1);
 * ```
 */

export type {
  EvalScenario,
  EvalRawResult,
  EvalResult,
  EvalSuiteResult,
  EvalScorecard,
  EvalBaseline,
  EvalGateResult,
  EvalDimension,
  DimensionScore,
  RegressionEntry,
  BaselineSuiteSummary,
} from '@pellux/goodvibes-sdk/platform/runtime/eval/types';

export { EvalRunner } from './runner.ts';
export type { EvalRunnerOptions } from './runner.ts';

export { scoreScenario, formatScorecard, DIMENSION_FLOOR } from '@pellux/goodvibes-sdk/platform/runtime/eval/scorecard';

export { BUILTIN_SUITES, ALL_SCENARIOS } from './suites.ts';

export {
  captureBaseline,
  serialiseBaseline,
  deserialiseBaseline,
  writeBaseline,
  loadBaseline,
  formatBaselineComparison,
} from '@pellux/goodvibes-sdk/platform/runtime/eval/baseline';

export { formatSuiteResult, formatGateResult } from '@pellux/goodvibes-sdk/platform/runtime/eval/format';
