/**
 * Compaction quality-score bridging tests.
 *
 * The TUI's real /compact path (ConversationManager.compact(), driven by
 * compactConversation() in runtime-services.ts) never instantiates the SDK's
 * CompactionManager pipeline, so computeQualityScore() (which that pipeline
 * calls) never runs in a real session. compaction-quality.ts calls it
 * directly and out-of-band instead. These tests validate that bridge in
 * isolation from the live /compact command.
 */
import { describe, expect, test } from 'bun:test';
import {
  formatQualityScoreLine,
  getCompactionQualityScore,
  recordCompactionQualityScore,
  scoreCompactionRun,
} from '../../renderer/compaction-quality.ts';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers';

function makeMsg(role: 'user' | 'assistant', content: string): ProviderMessage {
  return { role, content };
}

// No reset hook exists for the module-level score store (matching the SDK's
// own compaction-event log, which also has none — see
// compaction-history-modal.test.ts's "guard with a conditional" precedent),
// so every timestamp key below is unique to this file and to its own test,
// to stay correct regardless of test execution order.

describe('scoreCompactionRun', () => {
  test('high compression + a handoff-shaped summary scores well (grade A/B)', () => {
    const messagesBefore: ProviderMessage[] = Array.from({ length: 20 }, (_, i) => makeMsg('user', `message number ${i} `.repeat(20)));
    const tokensBefore = 50_000;
    const tokensAfter = 6_500; // ~87% compression
    const messagesAfter: ProviderMessage[] = [
      makeMsg('user', '[Session compacted] This is a condensed handoff summarizing the prior conversation context window in detail.'),
    ];
    const score = scoreCompactionRun({
      sessionId: 'session-1',
      contextWindow: 200_000,
      messagesBefore,
      messagesAfter,
      tokensBefore,
      tokensAfter,
    });
    expect(score.compressionRatio).toBeCloseTo((tokensBefore - tokensAfter) / tokensBefore, 2);
    expect(score.score).toBeGreaterThan(0.5);
    expect(['A', 'B']).toContain(score.grade);
    expect(score.isLowQuality).toBe(false);
  });

  test('near-zero compression and no handoff signal scores poorly (isLowQuality)', () => {
    const messagesBefore: ProviderMessage[] = [makeMsg('user', 'hi')];
    const messagesAfter: ProviderMessage[] = [makeMsg('user', 'x')];
    const score = scoreCompactionRun({
      sessionId: 'session-1',
      contextWindow: 200_000,
      messagesBefore,
      messagesAfter,
      tokensBefore: 100,
      tokensAfter: 100,
    });
    expect(score.compressionRatio).toBeLessThanOrEqual(0);
    expect(score.isLowQuality).toBe(true);
    expect(score.grade).toBe('F');
  });

  test('does not throw or claim a real strategy escalation ran', () => {
    const score = scoreCompactionRun({
      sessionId: 's',
      contextWindow: 0,
      messagesBefore: [],
      messagesAfter: [],
      tokensBefore: 0,
      tokensAfter: 0,
    });
    expect(typeof score.score).toBe('number');
    const line = formatQualityScoreLine(score);
    expect(line).toContain('rubric applied out-of-band');
    expect(line).toContain('no strategy escalation ran');
  });
});

describe('formatQualityScoreLine', () => {
  test('includes the grade and score from describeScore()', () => {
    const score = scoreCompactionRun({
      sessionId: 's',
      contextWindow: 200_000,
      messagesBefore: [makeMsg('user', 'a'.repeat(4000))],
      messagesAfter: [makeMsg('user', '[Session compacted] handoff summary of prior work in this session')],
      tokensBefore: 1_000,
      tokensAfter: 100,
    });
    const line = formatQualityScoreLine(score);
    expect(line).toContain('Quality:');
    expect(line).toContain(score.grade);
  });
});

describe('recordCompactionQualityScore / getCompactionQualityScore', () => {
  test('scores are retrievable by the exact timestamp key they were recorded under', () => {
    const score = scoreCompactionRun({
      sessionId: 's',
      contextWindow: 200_000,
      messagesBefore: [makeMsg('user', 'a'.repeat(400))],
      messagesAfter: [makeMsg('user', 'b')],
      tokensBefore: 100,
      tokensAfter: 10,
    });
    recordCompactionQualityScore(-1_000_001, score);
    expect(getCompactionQualityScore(-1_000_001)).toEqual(score);
  });

  test('an unrecorded timestamp returns undefined rather than fabricating a score', () => {
    expect(getCompactionQualityScore(-1_000_002)).toBeUndefined();
  });

  test('bounds the store the same way the SDK bounds its own compaction event log (evicts oldest)', () => {
    const score = scoreCompactionRun({
      sessionId: 's',
      contextWindow: 0,
      messagesBefore: [],
      messagesAfter: [],
      tokensBefore: 0,
      tokensAfter: 0,
    });
    // Negative, monotonically-decreasing keys unique to this test so it stays
    // correct regardless of what other tests/files have already recorded.
    const base = -2_000_000;
    for (let i = 0; i < 60; i++) {
      recordCompactionQualityScore(base - i, score);
    }
    // The 10 oldest insertions (base-0 .. base-9) should have been evicted
    // once the store exceeded its 50-entry cap; the most recent (base-59)
    // should still resolve.
    expect(getCompactionQualityScore(base)).toBeUndefined();
    expect(getCompactionQualityScore(base - 59)).toEqual(score);
  });
});
