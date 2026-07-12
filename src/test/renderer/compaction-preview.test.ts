/**
 * Compaction preview tests.
 *
 * Validates:
 *  1. Preview text is clearly labelled as an estimate.
 *  2. Preview contains accurate before-state (message count, token estimate).
 *  3. After-notice uses real CompactionEvent figures, not estimates.
 *  4. Pinned memory count appears in both preview and after-notice.
 *  5. Trigger label (auto vs manual) is reflected in the text.
 *  6. Empty conversation is handled without crashing.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildCompactionPreview,
  buildCompactionAfterNotice,
} from '../../renderer/compaction-preview.ts';
import { scoreCompactionRun } from '../../renderer/compaction-quality.ts';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers';

function makeMsg(role: 'user' | 'assistant', content: string): ProviderMessage {
  return { role, content };
}

function makeEvent(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    timestamp: Date.now(),
    messagesBeforeCompaction: 20,
    messagesAfterCompaction: 1,
    tokensBeforeEstimate: 50_000,
    tokensAfterEstimate: 6_500,
    modelId: 'test-model',
    trigger: 'manual',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCompactionPreview
// ---------------------------------------------------------------------------

describe('buildCompactionPreview', () => {
  test('labels output as estimate', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello world')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).toContain('estimate');
  });

  test('includes message count from input messages', () => {
    const msgs: ProviderMessage[] = [
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'world'),
      makeMsg('user', 'foo'),
    ];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).toContain('3 messages');
  });

  test('shows token estimate from message content', () => {
    // 4 chars = 1 token per SDK estimateConversationTokens rule
    const msgs: ProviderMessage[] = [makeMsg('user', 'aaaa')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    // Should contain "~1" token estimate (ceil(4/4) = 1)
    expect(result).toMatch(/~[\d,]+.*token/);
  });

  test('shows context window % when contextWindow > 0', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'a'.repeat(400))];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 1_000, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).toContain('% of');
    expect(result).toContain('context window');
  });

  test('omits context window % when contextWindow is 0', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).not.toContain('context window');
  });

  test('mentions pinned memory count when > 0', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 3, trigger: 'manual' });
    expect(result).toContain('3 pinned');
    expect(result).toContain('preserved');
  });

  test('does not mention pinned memory when count is 0', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).not.toContain('pinned');
  });

  test('uses "Compacting" for manual trigger', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).toContain('Compacting');
  });

  test('uses "Auto-compacting" for auto trigger', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'auto' });
    expect(result).toContain('Auto-compacting');
  });

  test('handles empty message array without crashing', () => {
    const result = buildCompactionPreview({ messages: [], contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('singular message label for 1 message', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 0, trigger: 'manual' });
    expect(result).toContain('1 message');
    // Must NOT say "1 messages" (plural)
    expect(result).not.toMatch(/1 messages/);
  });

  test('singular pinned memory label for 1 memory', () => {
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const result = buildCompactionPreview({ messages: msgs, contextWindow: 0, pinnedMemoryCount: 1, trigger: 'manual' });
    expect(result).toContain('1 pinned session memory');
    expect(result).not.toContain('memories');
  });
});

// ---------------------------------------------------------------------------
// buildCompactionAfterNotice
// ---------------------------------------------------------------------------

describe('buildCompactionAfterNotice', () => {
  test('uses real before/after message counts from CompactionEvent', () => {
    const event = makeEvent({ messagesBeforeCompaction: 20, messagesAfterCompaction: 1 });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    expect(result).toContain('20');
    expect(result).toContain('1');
  });

  test('shows before/after token estimates from CompactionEvent', () => {
    const event = makeEvent({ tokensBeforeEstimate: 50_000, tokensAfterEstimate: 6_500 });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    expect(result).toContain('50,000');
    expect(result).toContain('6,500');
  });

  test('computes savings percentage from real event figures', () => {
    const event = makeEvent({ tokensBeforeEstimate: 10_000, tokensAfterEstimate: 2_000 });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    // Savings: 8000 / 10000 = 80%
    expect(result).toContain('80%');
  });

  test('does not say "estimate" for after-notice (real figures used)', () => {
    const event = makeEvent();
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    // After-notice uses real CompactionEvent data; must not say "estimate"
    expect(result.toLowerCase()).not.toContain('estimate');
  });

  test('mentions pinned memory count when > 0', () => {
    const event = makeEvent();
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 2 });
    expect(result).toContain('2 pinned');
    expect(result).toContain('preserved');
  });

  test('uses "Auto-compact complete" for auto trigger', () => {
    const event = makeEvent({ trigger: 'auto' });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    expect(result).toContain('Auto-compact complete');
  });

  test('uses "Compact complete" for manual trigger', () => {
    const event = makeEvent({ trigger: 'manual' });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    expect(result).toContain('Compact complete');
  });

  test('handles zero savings gracefully (no negative percent)', () => {
    const event = makeEvent({ tokensBeforeEstimate: 5_000, tokensAfterEstimate: 5_000 });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    // Savings should be 0%, not negative
    expect(result).toContain('0%');
    expect(result).not.toMatch(/-\d+%/);
  });

  // -------------------------------------------------------------------------
  // qualityScore () — additive, optional field
  // -------------------------------------------------------------------------

  test('omits the quality line entirely when qualityScore is not provided (unchanged existing behaviour)', () => {
    const event = makeEvent();
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    expect(result).not.toContain('Quality:');
  });

  test('omits the quality line when qualityScore is explicitly null', () => {
    const event = makeEvent();
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0, qualityScore: null });
    expect(result).not.toContain('Quality:');
  });

  test('renders a grade line when a qualityScore is provided, honestly labelled as an out-of-band rubric', () => {
    const event = makeEvent({ tokensBeforeEstimate: 50_000, tokensAfterEstimate: 6_500 });
    const qualityScore = scoreCompactionRun({
      sessionId: 's',
      contextWindow: 200_000,
      messagesBefore: [makeMsg('user', 'a'.repeat(50_000))],
      messagesAfter: [makeMsg('user', '[Session compacted] a condensed handoff summary of this conversation context')],
      tokensBefore: 50_000,
      tokensAfter: 6_500,
    });
    const result = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0, qualityScore });
    expect(result).toContain('Quality:');
    expect(result).toContain(qualityScore.grade);
    expect(result).toContain('rubric applied out-of-band');
  });
});
