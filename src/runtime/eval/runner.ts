/**
 * Evaluation Harness — EvalRunner.
 *
 * Runs eval suites using production runtime paths:
 * - PerfMonitor for budget evaluation
 * - SloCollector for SLO p95 measurements
 * - scoreScenario() for dimension scoring
 *
 * The runner does not mock any dependencies — it exercises the real
 * production code paths that gate CI.
 */

import type { EvalScenario, EvalRawResult, EvalResult, EvalSuiteResult, EvalGateResult, EvalBaseline, RegressionEntry } from './types.ts';
import { scoreScenario } from './scorecard.ts';
import { createPerfMonitor } from '../perf/index.ts';
import { summarizeError } from '../../utils/error-display.ts';

// ── EvalRunner ────────────────────────────────────────────────────────────────

export interface EvalRunnerOptions {
  /**
   * Regression threshold for gate comparisons.
   * A scenario regresses if its composite score drops by more than this amount.
   * Default: 5 (5-point drop).
   */
  regressionThreshold?: number;
}

/**
 * Runs eval suites and produces structured results.
 *
 * @example
 * ```ts
 * const runner = new EvalRunner();
 * const result = await runner.runSuite(mySuite);
 * if (!result.passed) process.exit(1);
 * ```
 */
export class EvalRunner {
  private readonly regressionThreshold: number;

  constructor(options: EvalRunnerOptions = {}) {
    this.regressionThreshold = options.regressionThreshold ?? 5;
  }

  /**
   * Run all scenarios in a suite sequentially.
   *
   * Each scenario:
   * 1. Calls scenario.run() via the production code path
   * 2. Evaluates the raw result through PerfMonitor (if perfReport is absent)
   * 3. Scores the result via scoreScenario()
   *
   * @param suite - Suite name (used for logging and baseline matching).
   * @param scenarios - Scenarios to run.
   * @returns Aggregated EvalSuiteResult.
   */
  async runSuite(suite: string, scenarios: EvalScenario[]): Promise<EvalSuiteResult> {
    const startedAt = Date.now();
    const results: EvalResult[] = [];

    for (const scenario of scenarios) {
      const result = await this._runScenario(scenario);
      results.push(result);
    }

    const finishedAt = Date.now();
    const meanScore =
      results.length > 0
        ? results.reduce((acc, r) => acc + r.scorecard.compositeScore, 0) / results.length
        : 0;

    const passed = results.every((r) => r.scorecard.passed);

    return { suite, startedAt, finishedAt, results, meanScore, passed };
  }

  /**
   * Compare a fresh suite result against a stored baseline.
   * Produces an EvalGateResult indicating whether CI should pass.
   *
   * @param fresh - Result from a freshly-run suite.
   * @param baseline - Previously stored baseline (may be undefined).
   * @returns Gate result with per-scenario regression entries.
   */
  evaluateGate(fresh: EvalSuiteResult, baseline: EvalBaseline | undefined): EvalGateResult {
    const regressions: RegressionEntry[] = [];

    if (baseline) {
      const baselineSuite = baseline.suites[fresh.suite];
      if (baselineSuite) {
        for (const result of fresh.results) {
          const baselineScore = baselineSuite.scenarioScores[result.scenario.id];
          if (baselineScore === undefined) continue;
          const freshScore = result.scorecard.compositeScore;
          const delta = freshScore - baselineScore;
          if (delta < -this.regressionThreshold) {
            regressions.push({
              scenarioId: result.scenario.id,
              scenarioName: result.scenario.name,
              baselineScore,
              freshScore,
              delta,
            });
          }
        }
      }
    }

    return {
      suite: fresh.suite,
      passed: regressions.length === 0,
      regressionThreshold: this.regressionThreshold,
      fresh,
      baseline,
      regressions,
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _runScenario(scenario: EvalScenario): Promise<EvalResult> {
    const startedAt = Date.now();
    let raw = await this._executeScenario(scenario);

    // If the scenario did not include a perfReport, run a minimal PerfMonitor
    // evaluation against an empty snapshot to at least populate the field.
    if (!raw.perfReport) {
      const monitor = createPerfMonitor();
      // Import createInitialUiPerfState inline to avoid a top-level import
      // that would couple the runner to the store domain at build time.
      const { createInitialUiPerfState } = await import('../store/domains/ui-perf.ts');
      raw = {
        ...raw,
        perfReport: monitor.evaluate({
          uiPerf: createInitialUiPerfState(),
          extraMetrics: {},
        }),
      };
    }

    const scorecard = scoreScenario(scenario.id, scenario.name, raw);
    const finishedAt = Date.now();

    return { scenario, raw, scorecard, startedAt, finishedAt };
  }

  /** Execute a scenario's run() function, catching and normalising errors. */
  private async _executeScenario(scenario: EvalScenario): Promise<EvalRawResult> {
    const t0 = Date.now();
    try {
      const raw = await scenario.run();
      return raw;
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errorMessage = summarizeError(err);
      return {
        completed: false,
        durationMs,
        errorMessage,
        safetyViolations: 0,
      };
    }
  }
}
