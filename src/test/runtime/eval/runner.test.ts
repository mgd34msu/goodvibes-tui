/**
 * Unit tests for the Evaluation Harness runner and scorecard scorer.
 */

import { describe, it, expect } from 'bun:test';
import { EvalRunner } from '@pellux/goodvibes-sdk/platform/runtime/eval/runner';
import { scoreScenario, DIMENSION_FLOOR } from '@pellux/goodvibes-sdk/platform/runtime/eval/scorecard';
import { captureBaseline, serialiseBaseline, deserialiseBaseline } from '@pellux/goodvibes-sdk/platform/runtime/eval/baseline';
import { BUILTIN_SUITES, ALL_SCENARIOS } from '@pellux/goodvibes-sdk/platform/runtime/eval/suites';
import type { EvalScenario, EvalRawResult } from '@pellux/goodvibes-sdk/platform/runtime/eval/types';

// ── scoreScenario ──────────────────────────────────────────────────────────────

describe('scoreScenario', () => {
  it('awards full composite score for a clean run', () => {
    const raw: EvalRawResult = {
      completed: true,
      durationMs: 200,
      safetyViolations: 0,
    };
    const sc = scoreScenario('test:clean', 'Clean Run', raw);
    expect(sc.compositeScore).toBeGreaterThanOrEqual(80);
    expect(sc.passed).toBe(true);
  });

  it('deducts points for safety violations', () => {
    const raw: EvalRawResult = {
      completed: true,
      durationMs: 200,
      safetyViolations: 2,
    };
    const sc = scoreScenario('test:violations', 'Violations', raw);
    const safeDim = sc.dimensions.find((d) => d.dimension === 'safety')!;
    expect(safeDim.score).toBe(20); // 100 - 2*40
    expect(sc.passed).toBe(false); // safety floor is 80
  });

  it('gives zero quality score when run did not complete', () => {
    const raw: EvalRawResult = {
      completed: false,
      durationMs: 5000,
      errorMessage: 'timeout',
    };
    const sc = scoreScenario('test:fail', 'Failed Run', raw);
    const qualDim = sc.dimensions.find((d) => d.dimension === 'quality')!;
    expect(qualDim.score).toBe(0);
    expect(sc.passed).toBe(false);
  });

  it('scores latency 100 for fast runs under 500ms', () => {
    const raw: EvalRawResult = { completed: true, durationMs: 100, safetyViolations: 0 };
    const sc = scoreScenario('test:fast', 'Fast Run', raw);
    const latDim = sc.dimensions.find((d) => d.dimension === 'latency')!;
    expect(latDim.score).toBe(100);
  });

  it('scores latency 0 for runs over 30s', () => {
    const raw: EvalRawResult = { completed: true, durationMs: 35_000, safetyViolations: 0 };
    const sc = scoreScenario('test:slow', 'Slow Run', raw);
    const latDim = sc.dimensions.find((d) => d.dimension === 'latency')!;
    expect(latDim.score).toBe(0);
  });

  it('awards full cost score when no token data is present', () => {
    const raw: EvalRawResult = { completed: true, durationMs: 200, safetyViolations: 0 };
    const sc = scoreScenario('test:nocost', 'No Cost', raw);
    const costDim = sc.dimensions.find((d) => d.dimension === 'cost')!;
    expect(costDim.score).toBe(100);
  });

  it('scores recovery 100 when recovery succeeded', () => {
    const raw: EvalRawResult = {
      completed: true,
      durationMs: 200,
      safetyViolations: 0,
      recoverySucceeded: true,
    };
    const sc = scoreScenario('test:recovery-ok', 'Recovery OK', raw);
    const recDim = sc.dimensions.find((d) => d.dimension === 'recovery')!;
    expect(recDim.score).toBe(100);
  });

  it('scores recovery 20 when recovery failed', () => {
    const raw: EvalRawResult = {
      completed: true,
      durationMs: 200,
      safetyViolations: 0,
      recoveryFailed: true,
    };
    const sc = scoreScenario('test:recovery-fail', 'Recovery Fail', raw);
    const recDim = sc.dimensions.find((d) => d.dimension === 'recovery')!;
    expect(recDim.score).toBe(20);
    // recovery floor is 60 — should fail
    expect(sc.passed).toBe(false);
  });

  it('composite score is the weighted sum of dimension scores', () => {
    const raw: EvalRawResult = { completed: true, durationMs: 100, safetyViolations: 0 };
    const sc = scoreScenario('test:weights', 'Weights', raw);
    const manual = sc.dimensions.reduce((acc, d) => acc + d.score * d.weight, 0);
    expect(Math.abs(sc.compositeScore - manual)).toBeLessThan(0.001);
  });

  it('exposes DIMENSION_FLOOR with all five dimensions', () => {
    const dims = ['safety', 'quality', 'latency', 'cost', 'recovery'] as const;
    for (const dim of dims) {
      expect(typeof DIMENSION_FLOOR[dim]).toBe('number');
      expect(DIMENSION_FLOOR[dim]).toBeGreaterThan(0);
    }
  });
});

// ── EvalRunner ─────────────────────────────────────────────────────────────────

describe('EvalRunner', () => {
  it('runs a single scenario and returns a valid result', async () => {
    const scenario: EvalScenario = {
      id: 'runner-test:single',
      name: 'Single Scenario',
      suite: 'runner-test',
      description: 'Basic runner test.',
      tags: [],
      async run() {
        return { completed: true, durationMs: 50, safetyViolations: 0 };
      },
    };

    const runner = new EvalRunner();
    const result = await runner.runSuite('runner-test', [scenario]);

    expect(result.suite).toBe('runner-test');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.scorecard.scenarioId).toBe('runner-test:single');
    expect(result.meanScore).toBeGreaterThan(0);
    expect(typeof result.passed).toBe('boolean');
  });

  it('normalises a thrown error to a failed raw result', async () => {
    const scenario: EvalScenario = {
      id: 'runner-test:throws',
      name: 'Throws',
      suite: 'runner-test',
      description: 'Throws an error.',
      tags: [],
      async run() {
        throw new Error('scenario exploded');
      },
    };

    const runner = new EvalRunner();
    const result = await runner.runSuite('runner-test', [scenario]);

    expect(result.results[0]!.raw.completed).toBe(false);
    expect(result.results[0]!.raw.errorMessage).toContain('scenario exploded');
  });

  it('returns an empty suite result when no scenarios are provided', async () => {
    const runner = new EvalRunner();
    const result = await runner.runSuite('empty', []);
    expect(result.results).toHaveLength(0);
    expect(result.meanScore).toBe(0);
    expect(result.passed).toBe(true); // vacuously
  });

  it('detects regressions in evaluateGate', () => {
    const runner = new EvalRunner({ regressionThreshold: 5 });
    const now = Date.now();

    const freshResult = {
      suite: 'test-suite',
      startedAt: now,
      finishedAt: now + 100,
      meanScore: 65,
      passed: true,
      results: [
        {
          scenario: { id: 's1', name: 'S1', suite: 'test-suite', description: '', tags: [], run: async () => ({ completed: true, durationMs: 0 }) },
          raw: { completed: true, durationMs: 50 },
          scorecard: {
            scenarioId: 's1', scenarioName: 'S1',
            dimensions: [], compositeScore: 65, passed: true,
          },
          startedAt: now,
          finishedAt: now + 50,
        },
      ],
    };

    const baseline = {
      label: 'main',
      capturedAt: now - 86400000,
      suites: {
        'test-suite': {
          meanScore: 90,
          scenarioScores: { s1: 90 },
        },
      },
    };

    const gate = runner.evaluateGate(freshResult, baseline);
    expect(gate.passed).toBe(false);
    expect(gate.regressions).toHaveLength(1);
    expect(gate.regressions[0]!.delta).toBeLessThan(-5);
  });

  it('passes gate when no baseline is provided', () => {
    const runner = new EvalRunner();
    const now = Date.now();
    const fresh = {
      suite: 'test-suite',
      startedAt: now,
      finishedAt: now + 100,
      meanScore: 80,
      passed: true,
      results: [],
    };
    const gate = runner.evaluateGate(fresh, undefined);
    expect(gate.passed).toBe(true);
    expect(gate.regressions).toHaveLength(0);
  });
});

// ── Baseline ──────────────────────────────────────────────────────────────────

describe('baseline serialisation', () => {
  it('round-trips through serialise/deserialise', () => {
    const now = Date.now();
    const suiteResult = {
      suite: 'test',
      startedAt: now,
      finishedAt: now + 100,
      meanScore: 85,
      passed: true,
      results: [
        {
          scenario: { id: 's1', name: 'S1', suite: 'test', description: '', tags: [], run: async () => ({ completed: true, durationMs: 0 }) },
          raw: { completed: true, durationMs: 50 },
          scorecard: { scenarioId: 's1', scenarioName: 'S1', dimensions: [], compositeScore: 85, passed: true },
          startedAt: now,
          finishedAt: now + 50,
        },
      ],
    };

    const baseline = captureBaseline('test-label', [suiteResult]);
    const json = serialiseBaseline(baseline);
    const restored = deserialiseBaseline(json);

    expect(restored.label).toBe('test-label');
    expect(restored.suites['test']?.scenarioScores['s1']).toBe(85);
  });

  it('throws on invalid baseline JSON', () => {
    expect(() => deserialiseBaseline('{"invalid":true}')).toThrow();
  });
});

// ── Built-in suites ───────────────────────────────────────────────────────────

describe('BUILTIN_SUITES', () => {
  it('contains at least three suites', () => {
    expect(Object.keys(BUILTIN_SUITES).length).toBeGreaterThanOrEqual(3);
  });

  it('all scenario ids are unique', () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all scenarios have non-empty names and suites', () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.suite.length).toBeGreaterThan(0);
      expect(s.id.length).toBeGreaterThan(0);
    }
  });

  it('runs the core-performance suite end-to-end', async () => {
    const scenarios = BUILTIN_SUITES['core-performance']!;
    const runner = new EvalRunner();
    const result = await runner.runSuite('core-performance', scenarios);
    expect(result.results.length).toBe(scenarios.length);
    // All built-in scenarios should produce scorecards with valid composite scores
    for (const r of result.results) {
      expect(r.scorecard.compositeScore).toBeGreaterThanOrEqual(0);
      expect(r.scorecard.compositeScore).toBeLessThanOrEqual(100);
    }
  });
});
