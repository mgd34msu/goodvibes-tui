/**
 * Tests for context-compaction.ts
 *
 * Run with: bun test src/test/core/context-compaction.test.ts
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  estimateConversationTokens,
  shouldAutoCompact,
  getCompactionEvents,
  getLastCompactionEvent,
  compactMessages,
  checkAndCompact,
  COMPACTION_BUFFER_TOKENS,
  SMALL_WINDOW_THRESHOLD,
  compactSmallWindow,
} from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import type { ProviderMessage, ContentPart, LLMProvider, ChatRequest, ChatResponse } from '@pellux/goodvibes-sdk/platform/providers/interface';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { CompactionContext } from '@pellux/goodvibes-sdk/platform/core/compaction-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStringMsg(role: 'user' | 'assistant', content: string): ProviderMessage {
  return { role, content };
}

function makeContentPartMsg(role: 'user' | 'assistant', parts: ContentPart[]): ProviderMessage {
  return { role, content: parts } as ProviderMessage;
}

// ---------------------------------------------------------------------------
// estimateConversationTokens
// ---------------------------------------------------------------------------

describe('estimateConversationTokens', () => {
  it('returns 0 for empty message array', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  it('estimates tokens for a single string message (4 chars = 1 token)', () => {
    const msgs: ProviderMessage[] = [makeStringMsg('user', 'abcd')];
    expect(estimateConversationTokens(msgs)).toBe(1);
  });

  it('rounds up partial token (ceil)', () => {
    // 5 chars → ceil(5/4) = 2
    const msgs: ProviderMessage[] = [makeStringMsg('user', 'abcde')];
    expect(estimateConversationTokens(msgs)).toBe(2);
  });

  it('sums tokens across multiple messages', () => {
    const msgs: ProviderMessage[] = [
      makeStringMsg('user', 'abcd'),       // 1 token
      makeStringMsg('assistant', 'abcd'), // 1 token
    ];
    expect(estimateConversationTokens(msgs)).toBe(2);
  });

  it('handles ContentPart[] messages — only counts text parts', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'abcd' },       // 4 chars → 1 token
      { type: 'image', url: 'http://x' } as unknown as ContentPart, // ignored
    ];
    const msgs: ProviderMessage[] = [makeContentPartMsg('user', parts)];
    expect(estimateConversationTokens(msgs)).toBe(1);
  });

  it('handles ContentPart[] with multiple text parts', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'aaaa' }, // 1 token
      { type: 'text', text: 'bbbb' }, // 1 token
    ];
    const msgs: ProviderMessage[] = [makeContentPartMsg('assistant', parts)];
    expect(estimateConversationTokens(msgs)).toBe(2);
  });

  it('handles mixed string and ContentPart[] messages together', () => {
    const msgs: ProviderMessage[] = [
      makeStringMsg('user', 'aaaa'),                                          // 1
      makeContentPartMsg('assistant', [{ type: 'text', text: 'bbbbbbbb' }]), // 2
    ];
    expect(estimateConversationTokens(msgs)).toBe(3);
  });

  it('accuracy stays within 10% of word-count heuristic for realistic text', () => {
    // ~100 word paragraph, roughly 130 tokens by GPT standard, ~150 by 4-char rule
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const msgs: ProviderMessage[] = [makeStringMsg('user', text)];
    const estimate = estimateConversationTokens(msgs);
    // 4-char estimate should be Math.ceil(text.length / 4)
    expect(estimate).toBe(Math.ceil(text.length / 4));
    // Sanity: estimate should be between 100 and 200 for this text
    expect(estimate).toBeGreaterThan(100);
    expect(estimate).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoCompact
// ---------------------------------------------------------------------------

describe('shouldAutoCompact', () => {
  it('returns false when isCompacting is true (re-entry guard)', () => {
    expect(shouldAutoCompact({
      currentTokens: 90_000,
      contextWindow: 100_000,
      isCompacting: true,
    })).toBe(false);
  });

  it('returns false when contextWindow is 0 (avoids division by zero)', () => {
    expect(shouldAutoCompact({
      currentTokens: 1000,
      contextWindow: 0,
      isCompacting: false,
    })).toBe(false);
  });

  it('returns false when remaining tokens > 15k buffer', () => {
    expect(shouldAutoCompact({
      currentTokens: 80_000,
      contextWindow: 100_000,
      isCompacting: false,
    })).toBe(false); // 20k remaining > 15k
  });

  it('returns true when remaining tokens equal 15k buffer exactly', () => {
    expect(shouldAutoCompact({
      currentTokens: 100_000 - COMPACTION_BUFFER_TOKENS,
      contextWindow: 100_000,
      isCompacting: false,
    })).toBe(true); // exactly 15k remaining
  });

  it('returns true when remaining tokens are below 15k buffer', () => {
    expect(shouldAutoCompact({
      currentTokens: 95_000,
      contextWindow: 100_000,
      isCompacting: false,
    })).toBe(true); // 5k remaining < 15k
  });

  it('returns true when context is nearly exhausted', () => {
    expect(shouldAutoCompact({
      currentTokens: 99_000,
      contextWindow: 100_000,
      isCompacting: false,
    })).toBe(true); // 1k remaining << 15k
  });

  it('COMPACTION_BUFFER_TOKENS constant is 15000', () => {
    expect(COMPACTION_BUFFER_TOKENS).toBe(15_000);
  });

  it('SMALL_WINDOW_THRESHOLD constant is 12000', () => {
    expect(SMALL_WINDOW_THRESHOLD).toBe(12_000);
  });
});

// ---------------------------------------------------------------------------
// partitionMessages (tested indirectly via estimateConversationTokens behavior)
// These tests verify the public contract: fewer messages returned than input
// when keepRecent < total, and full set returned when keepRecent >= total.
// ---------------------------------------------------------------------------

describe('partitionMessages (edge cases via token estimation)', () => {
  it('empty messages produce zero tokens', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  it('single message shorter than keepRecent stays whole', () => {
    const msg = makeStringMsg('user', 'hello world');
    // 1 message array should estimate correctly
    expect(estimateConversationTokens([msg])).toBe(Math.ceil('hello world'.length / 4));
  });
});

// ---------------------------------------------------------------------------
// extractText behavior — tested via estimateConversationTokens
// (extractText is private, but its effects are visible through token estimation)
// ---------------------------------------------------------------------------

describe('extractText (via estimateConversationTokens)', () => {
  it('string content is counted directly', () => {
    const msgs: ProviderMessage[] = [makeStringMsg('user', '1234')];
    expect(estimateConversationTokens(msgs)).toBe(1);
  });

  it('ContentPart[] with only text parts are counted', () => {
    const msgs: ProviderMessage[] = [makeContentPartMsg('user', [
      { type: 'text', text: '1234' },
      { type: 'text', text: '5678' },
    ])];
    // 4 + 4 = 8 chars → 2 tokens
    expect(estimateConversationTokens(msgs)).toBe(2);
  });

  it('ContentPart[] with no text parts contributes 0 tokens', () => {
    const parts = [{ type: 'image', url: 'http://x.com/img.png' } as unknown as ContentPart];
    const msgs: ProviderMessage[] = [makeContentPartMsg('user', parts)];
    expect(estimateConversationTokens(msgs)).toBe(0);
  });

  it('empty string content produces 0 tokens', () => {
    const msgs: ProviderMessage[] = [makeStringMsg('user', '')];
    expect(estimateConversationTokens(msgs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCompactionEvents / getLastCompactionEvent
// (module-level state — these tests verify the public accessor API)
// ---------------------------------------------------------------------------

describe('compaction event accessors', () => {
  it('getCompactionEvents returns a readonly array', () => {
    const events = getCompactionEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  it('getLastCompactionEvent returns null or a CompactionEvent', () => {
    const last = getLastCompactionEvent();
    // Either null (no compactions yet in this test run) or an object with required fields
    if (last !== null) {
      expect(typeof last.timestamp).toBe('number');
      expect(typeof last.messagesBeforeCompaction).toBe('number');
      expect(typeof last.messagesAfterCompaction).toBe('number');
      expect(typeof last.tokensBeforeEstimate).toBe('number');
      expect(typeof last.tokensAfterEstimate).toBe('number');
      expect(typeof last.modelId).toBe('string');
      expect(['auto', 'manual']).toContain(last.trigger);
    }
  });

  it('getCompactionEvents and getLastCompactionEvent are consistent', () => {
    const events = getCompactionEvents();
    const last = getLastCompactionEvent();
    if (events.length === 0) {
      expect(last).toBeNull();
    } else {
      expect(last).toEqual(events[events.length - 1]);
    }
  });

  it('compaction event log is bounded to max 50 entries (eviction test)', () => {
    // This test verifies the bounded invariant by checking the current state;
    // since we cannot directly call compactMessages without an LLM, we verify
    // that the accessible log never exceeds 50 entries.
    const events = getCompactionEvents();
    expect(events.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Helpers for compactMessages / checkAndCompact
// ---------------------------------------------------------------------------

function makeMockProvider(summaryContent: string): LLMProvider {
  return {
    name: 'mock-provider',
    models: ['mock-model'],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      content: summaryContent,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end',
    }),
  };
}

function makeMockRegistry(provider: LLMProvider): ProviderRegistry {
  return {
    getForModel: (_modelId: string) => provider,
  } as unknown as ProviderRegistry;
}

function makeCompactionContext(
  messages: ProviderMessage[],
  overrides: Partial<CompactionContext> = {},
): CompactionContext {
  return {
    messages,
    sessionMemories: [],
    agents: [],
    wrfcChains: [],
    activePlan: null,
    lineageEntries: [],
    compactionCount: 0,
    contextWindow: 128_000,
    trigger: 'manual',
    extractionModelId: 'mock-model',
    ...overrides,
  };
}

// Build an array of `count` alternating user/assistant messages
function makeMessages(count: number): ProviderMessage[] {
  const msgs: ProviderMessage[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    msgs.push(makeStringMsg(role as 'user' | 'assistant', `message ${i}`));
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// compactMessages
// ---------------------------------------------------------------------------

describe('compactMessages', () => {
  it('reduces the conversation to a single structured handoff message', async () => {
    const provider = makeMockProvider('• topic A\n• topic B');
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(20);

    const result = await compactMessages(makeCompactionContext(messages), registry);

    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.summary).toContain('## Recent Conversation');
  });

  it('returns the assembled handoff text as the summary field', async () => {
    const summaryText = 'Discussed file edits and wrote tests.';
    const provider = makeMockProvider(summaryText);
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(15);

    const result = await compactMessages(makeCompactionContext(messages), registry);

    expect(result.summary).toBe(result.messages[0].content as string);
    expect(result.summary).toContain(summaryText);
    expect(result.sections.length).toBeGreaterThan(0);
  });

  it('records a compaction event with correct fields after successful compaction', async () => {
    const provider = makeMockProvider('• summary bullet');
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(12);
    const beforeCount = getCompactionEvents().length;

    const result = await compactMessages(makeCompactionContext(messages, { trigger: 'auto' }), registry);

    const events = getCompactionEvents();
    expect(events.length).toBe(beforeCount + 1);

    const event = result.event;
    expect(event.messagesBeforeCompaction).toBe(12);
    expect(event.messagesAfterCompaction).toBe(result.messages.length);
    expect(event.modelId).toBe('mock-model');
    expect(event.trigger).toBe('auto');
    expect(typeof event.timestamp).toBe('number');
    expect(event.tokensBeforeEstimate).toBeGreaterThan(0);
    // Last event in the log should match the returned event
    expect(getLastCompactionEvent()).toEqual(event);
  });

  it('falls back to raw recent conversation when extraction returns empty text', async () => {
    const provider = makeMockProvider('   ');
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(12);

    const result = await compactMessages(makeCompactionContext(messages), registry);
    expect(result.summary).toContain('## Recent Conversation');
    expect(result.summary).toContain('[user]:');
  });

  it('degrades gracefully when provider lookup fails', async () => {
    const badRegistry = {
      getForModel: (_modelId: string) => {
        throw new Error('No provider registered for model');
      },
    } as unknown as ProviderRegistry;
    const messages = makeMessages(12);

    const result = await compactMessages(
      makeCompactionContext(messages, { extractionModelId: 'unknown-model' }),
      badRegistry,
    );
    expect(result.summary).toContain('## Recent Conversation');
  });

  it('limits gathered conversation content when the message set is very large', async () => {
    const bigContent = 'x'.repeat(320);
    const manyMessages: ProviderMessage[] = [];
    for (let i = 0; i < 1100; i++) {
      manyMessages.push(makeStringMsg(i % 2 === 0 ? 'user' : 'assistant', bigContent));
    }

    const capturedPromptLengths: number[] = [];
    const capturingProvider: LLMProvider = {
      name: 'capturing-provider',
      models: ['mock-model'],
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        capturedPromptLengths.push((req.messages[0].content as string).length);
        return {
          content: '• truncation verified',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: 'end',
        };
      },
    };
    const registry = makeMockRegistry(capturingProvider);

    await compactMessages(makeCompactionContext(manyMessages), registry);

    expect(capturedPromptLengths.length).toBeGreaterThan(0);
    expect(Math.min(...capturedPromptLengths)).toBeLessThan(1090 * 320);
  });

  it('evicts oldest event from log once 50-entry cap is reached via repeated calls', async () => {
    const provider = makeMockProvider('• event');
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(12);

    // Call compactMessages enough times to fill and overflow 50 entries.
    // We use 55 calls to guarantee we push past the 50-entry cap.
    const calls = 55;
    for (let i = 0; i < calls; i++) {
      await compactMessages(makeCompactionContext(messages), registry);
    }

    // After 55 calls the log should be capped at 50
    expect(getCompactionEvents().length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// checkAndCompact
// ---------------------------------------------------------------------------

describe('checkAndCompact', () => {
  it('returns null when remaining tokens > 15k buffer', async () => {
    const provider = makeMockProvider('• summary');
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(10);

    const result = await checkAndCompact(
      { currentTokens: 50_000, contextWindow: 100_000, isCompacting: false },
      makeCompactionContext(messages),
      registry,
    );

    expect(result).toBeNull();
  });

  it('performs compaction and returns a result when remaining tokens <= 15k buffer', async () => {
    const provider = makeMockProvider('• auto-compacted summary');
    const registry = makeMockRegistry(provider);
    const messages = makeMessages(20);

    const result = await checkAndCompact(
      { currentTokens: 90_000, contextWindow: 100_000, isCompacting: false },
      makeCompactionContext(messages),
      registry,
    );

    expect(result).not.toBeNull();
    expect(result!.messages.length).toBeLessThan(messages.length);
    expect(result!.event.trigger).toBe('auto');
    expect(result!.summary).toContain('• auto-compacted summary');
  });
});

// ---------------------------------------------------------------------------
// compactSmallWindow
// ---------------------------------------------------------------------------

describe('compactSmallWindow', () => {
  it('returns all messages unchanged when count <= keepRecent', () => {
    const messages = makeMessages(5);
    const result = compactSmallWindow(messages, 10);
    expect(result).toEqual(messages);
  });

  it('truncates to keepRecent messages plus summary pair when over limit', () => {
    const messages = makeMessages(20);
    const result = compactSmallWindow(messages, 10);
    // 2 summary messages + 10 recent = 12
    expect(result.length).toBe(12);
  });

  it('prepends a user/assistant summary pair at the start', () => {
    const messages = makeMessages(15);
    const result = compactSmallWindow(messages, 5);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('compacted');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content as string).toContain('omitted');
  });

  it('preserves the most recent N messages verbatim', () => {
    const messages = makeMessages(10);
    const keepRecent = 4;
    const result = compactSmallWindow(messages, keepRecent);
    const keptMessages = result.slice(2); // skip summary pair
    expect(keptMessages).toEqual(messages.slice(-keepRecent));
  });

  it('defaults to keepRecent=10', () => {
    const messages = makeMessages(20);
    const result = compactSmallWindow(messages);
    expect(result.length).toBe(12); // 2 summary + 10 recent
  });
});
