/**
 * Compaction quality scoring and strategy auto-switch tests.
 *
 * Covers:
 * - Quality score computation (compression ratio + semantic retention signals)
 * - Grade assignment by score threshold
 * - Low-quality detection and isLowQuality flag
 * - Strategy escalation path (escalateStrategy)
 * - Diagnostics: describeScore produces readable output
 * - Manager-level strategy switch on low score (end-to-end)
 */
import { describe, test, expect } from 'bun:test';
import {
  computeQualityScore,
  describeScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from '../../../runtime/compaction/quality-score.ts';
import type { CompactionQualityScore } from '../../../runtime/compaction/quality-score.ts';
import {
  createCompactionManager,
} from '../../../runtime/compaction/index.ts';
import type {
  StrategyInput,
  StrategyOutput,
  CompactionStrategy,
} from '../../../runtime/compaction/types.ts';
import type { ProviderMessage } from '../../../providers/interface.ts';
import type { RuntimeEventBus } from '../../../runtime/events/index.ts';
import type { FeatureFlagManager } from '../../../runtime/feature-flags/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(role: 'user' | 'assistant', text: string): ProviderMessage {
  if (role === 'user') {
    return { role, content: [{ type: 'text', text }] };
  }
  return { role, content: text };
}

function makeStrategyInput(
  overrides: Partial<StrategyInput> & { strategy: CompactionStrategy },
): StrategyInput {
  const messages: ProviderMessage[] = Array.from({ length: 30 }, (_, i) =>
    makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message content number ${i} with some more text`),
  );
  return {
    sessionId: 'test-session',
    messages,
    tokensBefore: 10000,
    contextWindow: 100000,
    ...overrides,
  };
}

function makeStrategyOutput(
  overrides: Partial<StrategyOutput> & { strategy: CompactionStrategy },
): StrategyOutput {
  return {
    messages: [
      {
        role: 'user',
        content: [{
          type: 'text',
          text: '[Session Micro-Compaction]\n10 earlier messages were summarised to reduce context size.\nThe conversation continues from the most recent 20 messages.',
        }],
      },
      makeMsg('user', 'recent context content here'),
    ],
    tokensAfter: 2000,
    summary: 'Test compaction summary.',
    durationMs: 50,
    warnings: [],
    ...overrides,
  };
}

function makeMockBus(): RuntimeEventBus {
  return {
    emit: () => {},
    on: () => () => {},
    off: () => {},
  } as unknown as RuntimeEventBus;
}

function makeMockFlags(enabled = true): FeatureFlagManager {
  return {
    isEnabled: (_flag: string) => enabled,
  } as unknown as FeatureFlagManager;
}

// ---------------------------------------------------------------------------
// computeQualityScore — unit tests
// ---------------------------------------------------------------------------

describe('computeQualityScore', () => {
  test('returns score between 0 and 1', () => {
    const input = makeStrategyInput({ strategy: 'microcompact' });
    const output = makeStrategyOutput({ strategy: 'microcompact' });
    const score = computeQualityScore(input, output);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(1);
  });

  test('compressionRatio is positive when output is smaller', () => {
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 10000 });
    const output = makeStrategyOutput({ strategy: 'microcompact', tokensAfter: 2000 });
    const score = computeQualityScore(input, output);
    expect(score.compressionRatio).toBeGreaterThan(0);
    expect(score.compressionRatio).toBeLessThanOrEqual(1);
  });

  test('compressionRatio is 0 when output is same size as input', () => {
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 5000 });
    const output = makeStrategyOutput({ strategy: 'microcompact', tokensAfter: 5000 });
    const score = computeQualityScore(input, output);
    expect(score.compressionRatio).toBe(0);
  });

  test('compressionRatio is 0 when output is larger than input (clamped)', () => {
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 1000 });
    const output = makeStrategyOutput({ strategy: 'microcompact', tokensAfter: 5000 });
    const score = computeQualityScore(input, output);
    // ratio is clamped at 0 for negative compression
    expect(score.compressionRatio).toBe(0);
  });

  test('good compression and valid signals produces high score', () => {
    // 80% reduction, valid handoff, non-trivial content
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 10000 });
    const output = makeStrategyOutput({ strategy: 'microcompact', tokensAfter: 2000 });
    const score = computeQualityScore(input, output);
    expect(score.score).toBeGreaterThan(LOW_QUALITY_THRESHOLD);
    expect(score.isLowQuality).toBe(false);
  });

  test('zero compression with missing signals produces low score', () => {
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 5000 });
    // Output with no handoff, trivial content
    const output: StrategyOutput = {
      messages: [makeMsg('user', 'hi')], // trivial, no handoff keyword
      tokensAfter: 5000,
      summary: '',
      strategy: 'microcompact',
      durationMs: 1,
      warnings: [],
    };
    const score = computeQualityScore(input, output);
    expect(score.isLowQuality).toBe(true);
    expect(score.score).toBeLessThan(LOW_QUALITY_THRESHOLD);
  });

  test('description is non-empty string', () => {
    const input = makeStrategyInput({ strategy: 'autocompact' });
    const output = makeStrategyOutput({ strategy: 'autocompact', tokensAfter: 3000 });
    const score = computeQualityScore(input, output);
    expect(typeof score.description).toBe('string');
    expect(score.description.length).toBeGreaterThan(0);
  });

  test('signals.hasHandoff is true when output contains handoff keyword', () => {
    const input = makeStrategyInput({ strategy: 'microcompact' });
    const output = makeStrategyOutput({ strategy: 'microcompact' });
    const score = computeQualityScore(input, output);
    expect(score.signals.hasHandoff).toBe(true);
  });

  test('signals.hasHandoff is false when no handoff keyword in output', () => {
    const input = makeStrategyInput({ strategy: 'microcompact' });
    const output: StrategyOutput = {
      messages: [makeMsg('user', 'regular message without keywords')],
      tokensAfter: 2000,
      summary: '',
      strategy: 'microcompact',
      durationMs: 1,
      warnings: [],
    };
    const score = computeQualityScore(input, output);
    expect(score.signals.hasHandoff).toBe(false);
  });

  test('messageCountSane is false when output exceeds input count', () => {
    const smallInput = makeStrategyInput({
      strategy: 'microcompact',
      messages: [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')],
    });
    // Produce MORE messages than input (pathological case)
    const output: StrategyOutput = {
      messages: Array.from({ length: 10 }, () => makeMsg('user', 'extra message')),
      tokensAfter: 5000,
      summary: '',
      strategy: 'microcompact',
      durationMs: 1,
      warnings: [],
    };
    const score = computeQualityScore(smallInput, output);
    expect(score.signals.messageCountSane).toBe(false);
  });

  test('tokensBefore of 0 does not throw (compressionRatio = 0)', () => {
    const input = makeStrategyInput({ strategy: 'collapse', tokensBefore: 0 });
    const output = makeStrategyOutput({ strategy: 'collapse', tokensAfter: 0 });
    expect(() => computeQualityScore(input, output)).not.toThrow();
    const score = computeQualityScore(input, output);
    expect(score.compressionRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Grade assignment
// ---------------------------------------------------------------------------

describe('grade assignment', () => {
  function makeScoreWithValue(score: number): CompactionQualityScore {
    // We construct a StrategyInput/Output that yields approximately the target score
    // by controlling tokensBefore/tokensAfter to set compression, and using a valid
    // handoff message to ensure retention signals are met.
    const input = makeStrategyInput({ strategy: 'autocompact', tokensBefore: 10000 });
    const tokensAfter = Math.round(10000 * (1 - score / 1.0));
    const output = makeStrategyOutput({
      strategy: 'autocompact',
      tokensAfter: Math.max(1, tokensAfter),
    });
    return computeQualityScore(input, output);
  }

  test('grade F when score is below LOW_QUALITY_THRESHOLD', () => {
    // Force a low score: zero compression, no handoff
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 1000 });
    const output: StrategyOutput = {
      messages: [makeMsg('user', 'hi')],
      tokensAfter: 1000,
      summary: '',
      strategy: 'microcompact',
      durationMs: 1,
      warnings: [],
    };
    const score = computeQualityScore(input, output);
    expect(score.grade).toBe('F');
    expect(score.isLowQuality).toBe(true);
  });

  test('grade A when score is >= 0.85', () => {
    // Very high compression, valid handoff
    const input = makeStrategyInput({ strategy: 'collapse', tokensBefore: 10000 });
    const output: StrategyOutput = {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '[Session Collapse — context collapsed to save tokens. Full conversation history replaced with this structured handoff note for session continuity.]' }],
      }],
      tokensAfter: 150,
      summary: 'Collapsed.',
      strategy: 'collapse',
      durationMs: 10,
      warnings: [],
    };
    const score = computeQualityScore(input, output);
    expect(score.grade).toBe('A');
    expect(score.isLowQuality).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeScore
// ---------------------------------------------------------------------------

describe('describeScore', () => {
  test('includes score and grade', () => {
    const input = makeStrategyInput({ strategy: 'autocompact', tokensBefore: 10000 });
    const output = makeStrategyOutput({ strategy: 'autocompact', tokensAfter: 2000 });
    const score = computeQualityScore(input, output);
    const desc = describeScore(score);
    expect(desc).toContain('score=');
    expect(desc).toContain(score.grade);
  });

  test('includes compression percentage', () => {
    const input = makeStrategyInput({ strategy: 'autocompact', tokensBefore: 10000 });
    const output = makeStrategyOutput({ strategy: 'autocompact', tokensAfter: 5000 });
    const score = computeQualityScore(input, output);
    const desc = describeScore(score);
    expect(desc).toContain('compression=');
    expect(desc).toContain('%');
  });

  test('includes LOW_QUALITY marker when isLowQuality', () => {
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 1000 });
    const output: StrategyOutput = {
      messages: [makeMsg('user', 'hi')],
      tokensAfter: 1000,
      summary: '',
      strategy: 'microcompact',
      durationMs: 1,
      warnings: [],
    };
    const score = computeQualityScore(input, output);
    const desc = describeScore(score);
    expect(desc).toContain('LOW_QUALITY');
  });

  test('does not include LOW_QUALITY when score is good', () => {
    const input = makeStrategyInput({ strategy: 'autocompact', tokensBefore: 10000 });
    const output = makeStrategyOutput({ strategy: 'autocompact', tokensAfter: 1000 });
    const score = computeQualityScore(input, output);
    expect(score.isLowQuality).toBe(false);
    if (!score.isLowQuality) {
      const desc = describeScore(score);
      expect(desc).not.toContain('LOW_QUALITY');
    }
  });
});

// ---------------------------------------------------------------------------
// escalateStrategy — unit tests
// ---------------------------------------------------------------------------

describe('escalateStrategy', () => {
  test('microcompact escalates to autocompact', () => {
    expect(escalateStrategy('microcompact')).toBe('autocompact');
  });

  test('autocompact escalates to collapse', () => {
    expect(escalateStrategy('autocompact')).toBe('collapse');
  });

  test('collapse stays at collapse (ceiling)', () => {
    expect(escalateStrategy('collapse')).toBe('collapse');
  });

  test('reactive stays at reactive (ceiling)', () => {
    expect(escalateStrategy('reactive')).toBe('reactive');
  });

  test('escalation is strictly more aggressive', () => {
    const escalated = escalateStrategy('microcompact');
    expect(escalated).not.toBe('microcompact');
  });
});

// ---------------------------------------------------------------------------
// Manager-level strategy switch tests
// ---------------------------------------------------------------------------

describe('CompactionManager — strategy switch on low quality score', () => {
  const SESSION_ID = 'score-switch-test';
  const CONTEXT_WINDOW = 100000;

  function makeManager(busOverride?: Partial<RuntimeEventBus>) {
    const bus = {
      emit: () => {},
      on: () => () => {},
      off: () => {},
      ...busOverride,
    } as unknown as RuntimeEventBus;
    return createCompactionManager({
      sessionId: SESSION_ID,
      bus,
      flags: makeMockFlags(true),
      contextWindow: CONTEXT_WINDOW,
      thresholdFraction: 0.5,
    });
  }

  function makeLargeMessages(count: number): ProviderMessage[] {
    return Array.from({ length: count }, (_, i) =>
      makeMsg(
        i % 2 === 0 ? 'user' : 'assistant',
        // 100-char payload per message to drive token estimation
        `Message ${i}: ${'x'.repeat(90)}`,
      ),
    );
  }

  test('compact returns a result with qualityScore when flag is enabled', async () => {
    const manager = makeManager();
    const messages = makeLargeMessages(40);
    const result = await manager.compact({
      messages,
      tokenCount: 60000,
      trigger: 'auto',
    });
    // Non-null result means compaction ran
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.qualityScore).not.toBeNull();
    }
  });

  test('qualityScore has expected fields', async () => {
    const manager = makeManager();
    const messages = makeLargeMessages(40);
    const result = await manager.compact({
      messages,
      tokenCount: 60000,
      trigger: 'auto',
    });
    expect(result).not.toBeNull();
    if (result !== null && result.qualityScore !== null) {
      const qs = result.qualityScore;
      expect(typeof qs.score).toBe('number');
      expect(typeof qs.compressionRatio).toBe('number');
      expect(typeof qs.retentionScore).toBe('number');
      expect(typeof qs.isLowQuality).toBe('boolean');
      expect(typeof qs.grade).toBe('string');
      expect(typeof qs.description).toBe('string');
    }
  });

  test('strategySwitchReason is null when quality is acceptable', async () => {
    const manager = makeManager();
    // Use enough messages that a meaningful reduction happens
    const messages = makeLargeMessages(60);
    const result = await manager.compact({
      messages,
      tokenCount: 60000,
      trigger: 'auto',
    });
    expect(result).not.toBeNull();
    if (result !== null) {
      // If quality is good, no switch reason
      if (result.qualityScore !== null && !result.qualityScore.isLowQuality) {
        expect(result.strategySwitchReason).toBeNull();
      }
    }
  });

  test('COMPACTION_QUALITY_SCORE event is emitted', async () => {
    const emittedEvents: string[] = [];
    const manager = makeManager({
      emit: (_domain: string, envelope: unknown) => {
        const evt = envelope as { payload?: { type?: string } };
        if (evt?.payload?.type) {
          emittedEvents.push(evt.payload.type);
        }
      },
    });
    const messages = makeLargeMessages(40);
    await manager.compact({ messages, tokenCount: 60000, trigger: 'auto' });
    expect(emittedEvents).toContain('COMPACTION_QUALITY_SCORE');
  });

  test('COMPACTION_STRATEGY_SWITCH event is emitted when strategy is escalated', async () => {
    const emittedEvents: Array<{ type: string; payload: unknown }> = [];
    // Craft a scenario where microcompact would be chosen but produce near-zero compression:
    // Use very few messages so microcompact has nothing to drop (all within keep window),
    // then force tokenCount above threshold.
    const manager = makeManager({
      emit: (_domain: string, envelope: unknown) => {
        const evt = envelope as { payload?: { type?: string } };
        if (evt?.payload?.type) {
          emittedEvents.push({ type: evt.payload.type, payload: evt.payload });
        }
      },
    });

    // Use 5 messages so microcompact keeps all of them (within DEFAULT_KEEP_RECENT=20),
    // resulting in zero compression → low quality score → switch
    const fewMessages = makeLargeMessages(5);
    const result = await manager.compact({
      messages: fewMessages,
      tokenCount: 60000, // above threshold (60k / 100k = 60% > 50%)
      trigger: 'auto',
    });

    expect(result).not.toBeNull();
    if (result !== null) {
      const switchEvent = emittedEvents.find((e) => e.type === 'COMPACTION_STRATEGY_SWITCH');
      // The switch event is present when the initial strategy had low quality
      if (result.strategySwitchReason !== null) {
        expect(switchEvent).toBeDefined();
      }
    }
  });

  test('compact returns null when feature flag is disabled', async () => {
    const manager = createCompactionManager({
      sessionId: SESSION_ID,
      bus: makeMockBus(),
      flags: makeMockFlags(false),
      contextWindow: CONTEXT_WINDOW,
    });
    const result = await manager.compact({
      messages: makeLargeMessages(40),
      tokenCount: 90000,
      trigger: 'auto',
    });
    expect(result).toBeNull();
  });

  test('escalation: result strategy is more aggressive when switch occurred', async () => {
    const manager = makeManager();
    // 5 messages within microcompact keep window → zero compression → switch
    const fewMessages = makeLargeMessages(5);
    const result = await manager.compact({
      messages: fewMessages,
      tokenCount: 60000,
      trigger: 'auto',
    });
    expect(result).not.toBeNull();
    if (result !== null && result.strategySwitchReason !== null) {
      // The final strategy must be different from the initially-selected one
      // (autocompact or collapse, not microcompact)
      expect(result.strategy).not.toBe('microcompact');
    }
  });

  test('result.warnings is an array', async () => {
    const manager = makeManager();
    const result = await manager.compact({
      messages: makeLargeMessages(40),
      tokenCount: 60000,
      trigger: 'auto',
    });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(Array.isArray(result.warnings)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// LOW_QUALITY_THRESHOLD constant
// ---------------------------------------------------------------------------

describe('LOW_QUALITY_THRESHOLD', () => {
  test('is a number between 0 and 1', () => {
    expect(typeof LOW_QUALITY_THRESHOLD).toBe('number');
    expect(LOW_QUALITY_THRESHOLD).toBeGreaterThan(0);
    expect(LOW_QUALITY_THRESHOLD).toBeLessThan(1);
  });

  test('scores below it are flagged as low quality', () => {
    // Use a scenario guaranteed to produce a score below the threshold
    const input = makeStrategyInput({ strategy: 'microcompact', tokensBefore: 1000 });
    const output: StrategyOutput = {
      messages: [makeMsg('user', 'x')], // no handoff, trivial, no compression
      tokensAfter: 1000,
      summary: '',
      strategy: 'microcompact',
      durationMs: 1,
      warnings: [],
    };
    const score = computeQualityScore(input, output);
    expect(score.score).toBeLessThan(LOW_QUALITY_THRESHOLD);
    expect(score.isLowQuality).toBe(true);
  });

  test('scores at or above it are not flagged as low quality', () => {
    const input = makeStrategyInput({ strategy: 'collapse', tokensBefore: 10000 });
    const output = makeStrategyOutput({ strategy: 'collapse', tokensAfter: 500 });
    const score = computeQualityScore(input, output);
    expect(score.score).toBeGreaterThanOrEqual(LOW_QUALITY_THRESHOLD);
    if (score.score >= LOW_QUALITY_THRESHOLD) {
      expect(score.isLowQuality).toBe(false);
    }
  });
});
