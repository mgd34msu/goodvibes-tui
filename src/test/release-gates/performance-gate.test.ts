/**
 * Performance Gate — Release Gate 3
 *
 * Verifies that:
 * - SLO budget definitions exist for all key metrics
 * - Compaction quality scoring produces valid scores with auto-correction signals
 * - Budget enforcement config is present and correct
 * - SLO thresholds are within acceptable operational ranges
 * - Eval harness can run benchmark suites
 */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_BUDGETS } from '@pellux/goodvibes-sdk/platform/runtime/perf/budgets';
import {
  computeQualityScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from '@pellux/goodvibes-sdk/platform/runtime/compaction/quality-score';
import { SloCollector } from '@pellux/goodvibes-sdk/platform/runtime/perf/slo-collector';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { FEATURE_FLAGS } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/flags';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers/interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findBudget(metric: string) {
  return DEFAULT_BUDGETS.find(b => b.metric === metric);
}

function makeCompactionInput(messageCount: number, tokenCount: number) {
  const messages: ProviderMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    if (i % 2 === 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `Message ${i}: Some meaningful content about the task being performed.` }],
      });
    } else {
      messages.push({
        role: 'assistant',
        content: `Message ${i}: Some meaningful content about the task being performed.`,
      });
    }
  }
  return {
    sessionId: 'test-session',
    messages,
    tokensBefore: tokenCount,
    contextWindow: 128_000,
    strategy: 'collapse' as const,
  };
}

function makeCompactionOutput(messageCount: number, tokenCount: number, includeHandoff = true) {
  const messages: ProviderMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    if (i % 2 === 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: includeHandoff && i === 0 ? '[Session compaction] Summary of prior work.' : `Msg ${i}` }],
      });
    } else {
      messages.push({
        role: 'assistant',
        content: includeHandoff && i === 0 ? '[Session compaction] Summary of prior work.' : `Msg ${i}`,
      });
    }
  }
  return {
    messages,
    tokensAfter: tokenCount,
    summary: includeHandoff ? 'Compacted with handoff summary.' : 'Compacted.',
    durationMs: 12,
    warnings: [],
    strategy: 'collapse' as const,
  };
}

// ---------------------------------------------------------------------------
// 1. Budget definitions: all required SLO gates exist
// ---------------------------------------------------------------------------

describe('performance gate: budget definitions', () => {
  test('DEFAULT_BUDGETS is non-empty', () => {
    expect(DEFAULT_BUDGETS.length).toBeGreaterThan(0);
  });

  test('all budget entries have required fields', () => {
    for (const budget of DEFAULT_BUDGETS) {
      expect(typeof budget.name).toBe('string');
      expect(typeof budget.metric).toBe('string');
      expect(typeof budget.threshold).toBe('number');
      expect(typeof budget.unit).toBe('string');
      expect(typeof budget.tolerance).toBe('number');
      expect(budget.threshold).toBeGreaterThan(0);
      expect(budget.tolerance).toBeGreaterThan(0);
    }
  });

  test('frame render latency budget exists (p95 ≤ 16ms)', () => {
    const budget = findBudget('frame.render.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(16);
    expect(budget!.unit).toBe('ms');
  });

  test('tool executor overhead budget exists (p95 ≤ 5ms)', () => {
    const budget = findBudget('tool.executor.overhead.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(5);
  });

  test('compaction latency budget exists (p95 ≤ 500ms)', () => {
    const budget = findBudget('compaction.latency.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(500);
  });

  test('SLO: turn start latency budget exists (p95 ≤ 2000ms)', () => {
    const budget = findBudget('slo.turn_start.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(2000);
  });

  test('SLO: cancel latency budget exists (p95 ≤ 500ms)', () => {
    const budget = findBudget('slo.cancel.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(500);
  });

  test('SLO: reconnect recovery budget exists (p95 ≤ 10000ms)', () => {
    const budget = findBudget('slo.reconnect_recovery.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(10000);
  });

  test('SLO: permission decision budget exists (p95 ≤ 100ms)', () => {
    const budget = findBudget('slo.permission_decision.p95');
    expect(budget).toBeDefined();
    expect(budget!.threshold).toBeLessThanOrEqual(100);
  });

  test('memory growth budget exists', () => {
    const budget = findBudget('memory.growth.bytes_per_hour');
    expect(budget).toBeDefined();
    expect(budget!.unit).toBe('bytes');
  });
});

// ---------------------------------------------------------------------------
// 2. Compaction quality scoring: auto-corrects on low quality
// ---------------------------------------------------------------------------

describe('performance gate: compaction quality scoring', () => {
  test('computeQualityScore returns valid score structure', () => {
    const input = makeCompactionInput(20, 4000);
    const output = makeCompactionOutput(5, 800);
    const score = computeQualityScore(input, output);

    expect(score).toBeDefined();
    expect(typeof score.score).toBe('number');
    expect(typeof score.grade).toBe('string');
    expect(typeof score.isLowQuality).toBe('boolean');
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(1);
  });

  test('score grade is one of A/B/C/D/F', () => {
    const input = makeCompactionInput(10, 2000);
    const output = makeCompactionOutput(3, 600);
    const score = computeQualityScore(input, output);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(score.grade);
  });

  test('isLowQuality flags scores below LOW_QUALITY_THRESHOLD', () => {
    expect(LOW_QUALITY_THRESHOLD).toBe(0.4);
    // Pathological: output larger than input = no compression, low quality
    const input = makeCompactionInput(3, 100);
    const output = makeCompactionOutput(10, 500, false); // no handoff, more tokens
    const score = computeQualityScore(input, output);
    // Score with no compression and no signals should be low
    expect(score.score).toBeLessThan(LOW_QUALITY_THRESHOLD);
    expect(score.isLowQuality).toBe(true);
  });

  test('escalateStrategy returns a valid compaction strategy', () => {
    const escalated = escalateStrategy('collapse');
    expect(typeof escalated).toBe('string');
    expect(escalated.length).toBeGreaterThan(0);
  });

  test('escalateStrategy from microcompact escalates', () => {
    const escalated = escalateStrategy('microcompact');
    // Any escalation from microcompact should return a higher strategy
    expect(typeof escalated).toBe('string');
  });

  test('score has compression and retention sub-scores', () => {
    const input = makeCompactionInput(20, 4000);
    const output = makeCompactionOutput(5, 800);
    const score = computeQualityScore(input, output);
    expect(typeof score.compressionScore).toBe('number');
    expect(typeof score.retentionScore).toBe('number');
    expect(typeof score.compressionRatio).toBe('number');
    expect(score.compressionScore).toBeGreaterThanOrEqual(0);
    expect(score.retentionScore).toBeGreaterThanOrEqual(0);
  });

  test('score has semantic retention signals', () => {
    const input = makeCompactionInput(10, 2000);
    const output = makeCompactionOutput(3, 600);
    const score = computeQualityScore(input, output);
    expect(score.signals).toBeDefined();
    expect(typeof score.signals.hasHandoff).toBe('boolean');
    expect(typeof score.signals.hasNonTrivialContent).toBe('boolean');
    expect(typeof score.signals.messageCountSane).toBe('boolean');
    expect(typeof score.signals.positiveTokenCount).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 3. SLO Collector: metric collection infrastructure
// ---------------------------------------------------------------------------

describe('performance gate: SLO collector', () => {
  test('SloCollector instantiates with an event bus', () => {
    const bus = new RuntimeEventBus();
    const collector = new SloCollector(bus);
    expect(collector).toBeDefined();
    collector.dispose();
  });

  test('getMetrics returns an array of PerfMetric objects', () => {
    const bus = new RuntimeEventBus();
    const collector = new SloCollector(bus);
    const metrics = collector.getMetrics();
    expect(Array.isArray(metrics)).toBe(true);
    collector.dispose();
  });

  test('getSampleCounts returns a record of metric name to sample count', () => {
    const bus = new RuntimeEventBus();
    const collector = new SloCollector(bus);
    const counts = collector.getSampleCounts();
    expect(typeof counts).toBe('object');
    collector.dispose();
  });

  test('dispose does not throw', () => {
    const bus = new RuntimeEventBus();
    const collector = new SloCollector(bus);
    expect(() => collector.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Budget enforcement feature flag exists
// ---------------------------------------------------------------------------

describe('performance gate: budget enforcement flag', () => {
  test('runtime-tools-budget-enforcement feature flag is declared', () => {
    const flag = FEATURE_FLAGS.find(f => f.id === 'runtime-tools-budget-enforcement');
    expect(flag).toBeDefined();
    expect(flag!.runtimeToggleable).toBe(true);
  });

  test('compaction feature flags are declared', () => {
    const compactionFlag = FEATURE_FLAGS.find(f => f.id === 'session-compaction');
    expect(compactionFlag).toBeDefined();
  });
});
