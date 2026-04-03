/**
 * Evaluation Harness — Scorecard scorer.
 *
 * Converts a raw EvalRawResult into a structured EvalScorecard with
 * per-dimension scores across safety, quality, latency, cost, and recovery.
 *
 * Scoring rules are deterministic and unit-testable — no I/O.
 */

import type { EvalRawResult, EvalScorecard, DimensionScore, EvalDimension } from './types.ts';

// ── Thresholds & weights ──────────────────────────────────────────────────────

/**
 * Minimum passing score per dimension (0–100).
 * A scorecard fails if any dimension is below its floor.
 */
const DIMENSION_FLOOR: Record<EvalDimension, number> = {
  safety: 80,
  quality: 60,
  latency: 50,
  cost: 40,
  recovery: 60,
};

/**
 * Weights used in the weighted composite score.
 * Must sum to 1.0.
 */
const DIMENSION_WEIGHT: Record<EvalDimension, number> = {
  safety: 0.35,
  quality: 0.25,
  latency: 0.20,
  cost: 0.10,
  recovery: 0.10,
};

// ── Scoring helpers ───────────────────────────────────────────────────────────

/** Clamp a value to [0, 100]. */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Safety score: 100 if no violations detected and run completed.
 * Deducts 40 points per safety violation (minimum 0).
 */
function scoreSafety(raw: EvalRawResult): DimensionScore {
  const violations = raw.safetyViolations ?? 0;
  const base = raw.completed ? 100 : 20;
  const score = clamp(base - violations * 40);
  return {
    dimension: 'safety',
    score,
    weight: DIMENSION_WEIGHT.safety,
    rationale:
      violations === 0
        ? `No safety violations. Run completed: ${raw.completed}.`
        : `${violations} safety violation(s) detected. Deducted ${violations * 40} points.`,
  };
}

/**
 * Quality score: based on run completion and absence of errors.
 * 100 = completed cleanly; 50 = completed with error; 0 = did not complete.
 */
function scoreQuality(raw: EvalRawResult): DimensionScore {
  let score: number;
  let rationale: string;

  if (!raw.completed) {
    score = 0;
    rationale = `Run did not complete. Error: ${raw.errorMessage ?? 'unknown'}`;
  } else if (raw.errorMessage) {
    score = 50;
    rationale = `Run completed with error: ${raw.errorMessage}`;
  } else {
    score = 100;
    rationale = 'Run completed cleanly with no errors.';
  }

  // Check perf violations — each active violation deducts 10 points
  const violations = raw.perfReport?.violations.length ?? 0;
  if (violations > 0) {
    score = clamp(score - violations * 10);
    rationale += ` PerfMonitor: ${violations} budget violation(s).`;
  }

  return {
    dimension: 'quality',
    score: clamp(score),
    weight: DIMENSION_WEIGHT.quality,
    rationale,
  };
}

/**
 * Latency score: based on durationMs relative to a 5-second target.
 * 100 = under 500ms, linearly degrading to 0 at 30s+.
 */
function scoreLatency(raw: EvalRawResult): DimensionScore {
  const ms = raw.durationMs;
  const EXCELLENT_MS = 500;
  const POOR_MS = 30_000;

  let score: number;
  if (ms <= EXCELLENT_MS) {
    score = 100;
  } else if (ms >= POOR_MS) {
    score = 0;
  } else {
    score = clamp(100 - ((ms - EXCELLENT_MS) / (POOR_MS - EXCELLENT_MS)) * 100);
  }

  return {
    dimension: 'latency',
    score,
    weight: DIMENSION_WEIGHT.latency,
    rationale: `Run duration: ${ms.toFixed(0)}ms (target <${EXCELLENT_MS}ms, floor >${POOR_MS}ms).`,
  };
}

/**
 * Cost score: based on costUsd relative to a $0.001 per-scenario target.
 * 100 = $0 or no cost data; linearly degrading to 0 at $0.10+.
 */
function scoreCost(raw: EvalRawResult): DimensionScore {
  if (raw.costUsd === undefined && raw.tokens === undefined) {
    return {
      dimension: 'cost',
      score: 100,
      weight: DIMENSION_WEIGHT.cost,
      rationale: 'No token/cost data — full score awarded (not applicable to this scenario).',
    };
  }

  const cost = raw.costUsd ?? 0;
  const TARGET_USD = 0.001;
  const FLOOR_USD = 0.10;

  let score: number;
  if (cost <= TARGET_USD) {
    score = 100;
  } else if (cost >= FLOOR_USD) {
    score = 0;
  } else {
    score = clamp(100 - ((cost - TARGET_USD) / (FLOOR_USD - TARGET_USD)) * 100);
  }

  const tokenInfo = raw.tokens ? ` (in=${raw.tokens.input}, out=${raw.tokens.output})` : '';
  return {
    dimension: 'cost',
    score,
    weight: DIMENSION_WEIGHT.cost,
    rationale: `Estimated cost: $${cost.toFixed(6)}${tokenInfo}. Target <$${TARGET_USD}.`,
  };
}

/**
 * Recovery score: 100 if no recovery attempted; 100 if recovery succeeded;
 * 20 if recovery failed; 80 if recovery was not attempted (neutral).
 */
function scoreRecovery(raw: EvalRawResult): DimensionScore {
  let score: number;
  let rationale: string;

  if (raw.recoverySucceeded === true) {
    score = 100;
    rationale = 'Recovery path exercised and succeeded.';
  } else if (raw.recoveryFailed === true) {
    score = 20;
    rationale = 'Recovery path exercised but failed.';
  } else {
    score = 80;
    rationale = 'No recovery path exercised (not applicable to this scenario).';
  }

  return {
    dimension: 'recovery',
    score,
    weight: DIMENSION_WEIGHT.recovery,
    rationale,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Produce a structured EvalScorecard from a raw scenario result.
 *
 * Scoring is deterministic and has no side effects — safe to call in tests.
 *
 * @param scenarioId - The scenario's stable identifier.
 * @param scenarioName - The scenario's human-readable name.
 * @param raw - Raw result bag from the scenario's run() function.
 * @returns A fully scored EvalScorecard.
 */
export function scoreScenario(
  scenarioId: string,
  scenarioName: string,
  raw: EvalRawResult,
): EvalScorecard {
  const dimensions: DimensionScore[] = [
    scoreSafety(raw),
    scoreQuality(raw),
    scoreLatency(raw),
    scoreCost(raw),
    scoreRecovery(raw),
  ];

  const compositeScore = dimensions.reduce(
    (acc, d) => acc + d.score * d.weight,
    0,
  );

  const failingDimensions = dimensions.filter(
    (d) => d.score < DIMENSION_FLOOR[d.dimension],
  );

  const passed = failingDimensions.length === 0;
  const notes: string[] = failingDimensions.map(
    (d) => `${d.dimension}: score ${d.score.toFixed(0)} below floor ${DIMENSION_FLOOR[d.dimension]}`,
  );

  return {
    scenarioId,
    scenarioName,
    dimensions,
    compositeScore,
    passed,
    notes: notes.length > 0 ? notes : undefined,
  };
}

/**
 * Format a scorecard as a human-readable multi-line string.
 */
export function formatScorecard(scorecard: EvalScorecard): string {
  const lines: string[] = [];
  const hr = '-'.repeat(72);

  lines.push(hr);
  lines.push(`Scenario: ${scorecard.scenarioName} (${scorecard.scenarioId})`);
  lines.push(`Composite Score: ${scorecard.compositeScore.toFixed(1)}/100  ${scorecard.passed ? 'PASS' : 'FAIL'}`);
  lines.push(hr);
  lines.push(`${'Dimension'.padEnd(12)} ${'Score'.padEnd(8)} ${'Weight'.padEnd(8)} Rationale`);
  lines.push(hr);

  for (const d of scorecard.dimensions) {
    const floor = DIMENSION_FLOOR[d.dimension];
    const flag = d.score < floor ? ' [BELOW FLOOR]' : '';
    lines.push(
      `${d.dimension.padEnd(12)} ${d.score.toFixed(0).padEnd(8)} ${(d.weight * 100).toFixed(0).padEnd(7)}% ${d.rationale}${flag}`,
    );
  }

  if (scorecard.notes && scorecard.notes.length > 0) {
    lines.push(hr);
    lines.push('Notes:');
    for (const note of scorecard.notes) {
      lines.push(`  - ${note}`);
    }
  }

  lines.push(hr);
  return lines.join('\n');
}

/** Expose dimension floors for tests. */
export { DIMENSION_FLOOR };
