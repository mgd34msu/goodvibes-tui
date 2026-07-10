/**
 * Unit tests for the Evaluation Harness format helpers.
 */

import { describe, it, expect } from 'bun:test';
import { formatSuiteResult, formatGateResult } from '@/runtime/index.ts';
import type { EvalSuiteResult, EvalGateResult } from '@/runtime/index.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSuiteResult(overrides: Partial<EvalSuiteResult> = {}): EvalSuiteResult {
  const now = Date.now();
  return {
    suite: 'test-suite',
    startedAt: now,
    finishedAt: now + 250,
    meanScore: 87.5,
    passed: true,
    results: [
      {
        scenario: { id: 's1', name: 'Scenario One', suite: 'test-suite', description: '', tags: [], run: async () => ({ completed: true, durationMs: 0, safetyViolations: 0 }) },
        raw: { completed: true, durationMs: 100, safetyViolations: 0 },
        scorecard: {
          scenarioId: 's1',
          scenarioName: 'Scenario One',
          dimensions: [],
          compositeScore: 87.5,
          passed: true,
        },
        startedAt: now,
        finishedAt: now + 100,
      },
    ],
    ...overrides,
  };
}

function makeGateResult(overrides: Partial<EvalGateResult> = {}): EvalGateResult {
  return {
    suite: 'test-suite',
    passed: true,
    regressionThreshold: 5,
    fresh: makeSuiteResult(),
    baseline: undefined,
    regressions: [],
    // SDK 1.6.1: the gate now reports absolute-floor failures and
    // unbaselined scenarios as first-class, required arrays; formatGateResult
    // reads both. Default them empty here (the passing-gate case).
    floorFailures: [],
    unbaselined: [],
    ...overrides,
  };
}

// ── formatSuiteResult ─────────────────────────────────────────────────────────

describe('formatSuiteResult', () => {
  it('includes suite name in output', () => {
    const result = formatSuiteResult(makeSuiteResult());
    expect(result).toContain('test-suite');
  });

  it('includes PASSED when suite passes', () => {
    const result = formatSuiteResult(makeSuiteResult({ passed: true }));
    expect(result).toContain('PASSED');
  });

  it('includes FAILED when suite fails', () => {
    const result = formatSuiteResult(makeSuiteResult({ passed: false, meanScore: 40 }));
    expect(result).toContain('FAILED');
  });

  it('includes scenario count', () => {
    const result = formatSuiteResult(makeSuiteResult());
    expect(result).toContain('Scenarios: 1');
  });

  it('includes mean score', () => {
    const result = formatSuiteResult(makeSuiteResult({ meanScore: 87.5 }));
    expect(result).toContain('87.5');
  });

  it('marks each scenario PASS or FAIL', () => {
    const result = formatSuiteResult(makeSuiteResult());
    expect(result).toContain('PASS');
  });

  it('marks failing scenario as FAIL', () => {
    const suite = makeSuiteResult();
    suite.results[0]!.scorecard.passed = false;
    const result = formatSuiteResult(suite);
    expect(result).toContain('FAIL');
  });

  it('returns a non-empty string', () => {
    const result = formatSuiteResult(makeSuiteResult());
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── formatGateResult ──────────────────────────────────────────────────────────

describe('formatGateResult', () => {
  it('includes suite name', () => {
    const result = formatGateResult(makeGateResult());
    expect(result).toContain('test-suite');
  });

  it('shows PASSED when gate passes', () => {
    const result = formatGateResult(makeGateResult({ passed: true }));
    expect(result).toContain('PASSED');
  });

  it('shows FAILED when gate fails', () => {
    const result = formatGateResult(makeGateResult({
      passed: false,
      regressions: [{
        scenarioId: 's1',
        scenarioName: 'Scenario One',
        baselineScore: 90,
        freshScore: 60,
        delta: -30,
      }],
    }));
    expect(result).toContain('FAILED');
  });

  it('lists regressions when present', () => {
    const result = formatGateResult(makeGateResult({
      passed: false,
      regressions: [{
        scenarioId: 's1',
        scenarioName: 'Scenario One',
        baselineScore: 90,
        freshScore: 60,
        delta: -30,
      }],
    }));
    expect(result).toContain('Regressions');
    expect(result).toContain('Scenario One');
  });

  it('shows no-baseline message when baseline is absent', () => {
    const result = formatGateResult(makeGateResult({ baseline: undefined }));
    expect(result).toContain('No baseline to compare against');
  });

  it('shows baseline label when baseline is present', () => {
    const baseline = {
      label: 'main',
      capturedAt: Date.now() - 86400000,
      suites: {},
    };
    const result = formatGateResult(makeGateResult({ passed: true, baseline, regressions: [] }));
    expect(result).toContain('main');
    expect(result).toContain('No regressions detected');
  });

  it('includes regression threshold', () => {
    const result = formatGateResult(makeGateResult({ regressionThreshold: 5 }));
    expect(result).toContain('5');
  });

  it('returns a non-empty string', () => {
    const result = formatGateResult(makeGateResult());
    expect(result.length).toBeGreaterThan(0);
  });
});
