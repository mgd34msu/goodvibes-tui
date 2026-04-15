/**
 * Tests for context window validation (Stage 8).
 *
 * Validates the pre-flight context window check in Orchestrator:
 * - Request within context passes through without interference
 * - Request exceeding context triggers auto-compact when enabled
 * - Request still exceeding after compact shows clear error with token counts
 * - Error message includes specific token counts and model context window
 * - Alternative model suggestion works when larger-context models are available
 *
 * Run with: bun test src/test/core/context-validation.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import { createModelCatalog, type ModelCatalog, type CatalogModelEntry } from '@pellux/goodvibes-sdk/platform/providers/model-catalog';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number, charsPerMessage = 40): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(charsPerMessage),
    });
  }
  return messages;
}

/** Build messages whose estimated token count roughly equals `targetTokens`. */
function makeMessagesWithTokens(targetTokens: number): ProviderMessage[] {
  // estimateConversationTokens uses ceil(chars / 4)
  // So for N tokens with 1 message: N * 4 chars
  return [{ role: 'user', content: 'x'.repeat(targetTokens * 4) }];
}

// ---------------------------------------------------------------------------
// estimateConversationTokens (basic sanity checks used by validation logic)
// ---------------------------------------------------------------------------

describe('estimateConversationTokens (validation foundation)', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  it('estimates tokens proportional to message length', () => {
    const messages = makeMessagesWithTokens(10_000);
    expect(estimateConversationTokens(messages)).toBe(10_000);
  });

  it('sums tokens across multiple messages', () => {
    const messages = makeMessages(4, 400); // 4 msgs x 400 chars = 1600 chars = 400 tokens
    expect(estimateConversationTokens(messages)).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// ModelCatalog interface (getCatalog)
// ---------------------------------------------------------------------------

describe('createModelCatalog()', () => {
  it('returns an object implementing ModelCatalog', () => {
    const catalog = createModelCatalog(createTestProviderRegistry());
    expect(typeof catalog.getModel).toBe('function');
    expect(typeof catalog.findLargerContextModels).toBe('function');
  });

  it('getModel returns null for an unknown model ID', () => {
    const catalog = createModelCatalog(createTestProviderRegistry());
    const result = catalog.getModel('totally-unknown-model-xyz-999');
    expect(result).toBeNull();
  });

  it('findLargerContextModels returns array (possibly empty) for large minContext', () => {
    const catalog = createModelCatalog(createTestProviderRegistry());
    // Using a very large context window that likely has no alternatives
    const results = catalog.findLargerContextModels(10_000_000);
    expect(Array.isArray(results)).toBe(true);
  });

  it('findLargerContextModels respects limit parameter', () => {
    const catalog = createModelCatalog(createTestProviderRegistry());
    // minContext = 0 should return many models; limit = 2 caps the result
    const results = catalog.findLargerContextModels(0, undefined, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('findLargerContextModels returns models sorted by context descending', () => {
    const catalog = createModelCatalog(createTestProviderRegistry());
    const results = catalog.findLargerContextModels(0, undefined, 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].context).toBeGreaterThanOrEqual(results[i].context);
    }
  });

  it('findLargerContextModels only includes models with context > minContext', () => {
    const catalog = createModelCatalog(createTestProviderRegistry());
    const minContext = 100_000;
    const results = catalog.findLargerContextModels(minContext, undefined, 10);
    for (const model of results) {
      expect(model.context).toBeGreaterThan(minContext);
    }
  });
});

// ---------------------------------------------------------------------------
// Context validation logic (tested as pure functions)
// ---------------------------------------------------------------------------

/**
 * Mirrors the core logic of checkContextWindowPreflight without needing
 * a full Orchestrator instance. Tests the decision boundaries directly.
 */
function simulatePreflightCheck(
  estimatedTokens: number,
  contextWindow: number,
  autoCompactEnabled: boolean,
  tokensAfterCompact: number,
): { result: 'ok' | 'compacted' | 'error'; compactTriggered: boolean } {
  if (contextWindow <= 0) return { result: 'ok', compactTriggered: false };
  if (estimatedTokens <= contextWindow) return { result: 'ok', compactTriggered: false };

  if (autoCompactEnabled) {
    // Simulate compact
    if (tokensAfterCompact <= contextWindow) {
      return { result: 'compacted', compactTriggered: true };
    }
    return { result: 'error', compactTriggered: true };
  }

  return { result: 'error', compactTriggered: false };
}

describe('context window pre-flight decision logic', () => {
  describe('request within context window', () => {
    it('returns ok when tokens < context window', () => {
      const { result, compactTriggered } = simulatePreflightCheck(
        50_000, 128_000, true, 0,
      );
      expect(result).toBe('ok');
      expect(compactTriggered).toBe(false);
    });

    it('returns ok when tokens exactly equal context window', () => {
      const { result } = simulatePreflightCheck(128_000, 128_000, true, 0);
      expect(result).toBe('ok');
    });

    it('returns ok when context window is 0 (unknown)', () => {
      // Context window 0 = unknown, skip validation
      const { result } = simulatePreflightCheck(500_000, 0, true, 0);
      expect(result).toBe('ok');
    });
  });

  describe('request exceeding context — auto-compact enabled', () => {
    it('triggers compact and returns compacted when post-compact tokens fit', () => {
      const { result, compactTriggered } = simulatePreflightCheck(
        150_000, // exceeds 128K
        128_000,
        true,    // auto-compact on
        60_000,  // after compact: fits
      );
      expect(result).toBe('compacted');
      expect(compactTriggered).toBe(true);
    });

    it('returns error when tokens still exceed after compact', () => {
      const { result, compactTriggered } = simulatePreflightCheck(
        200_000,
        128_000,
        true,
        140_000, // still exceeds after compact
      );
      expect(result).toBe('error');
      expect(compactTriggered).toBe(true);
    });

    it('compact is triggered even at 1 token over the limit', () => {
      const { compactTriggered } = simulatePreflightCheck(
        128_001, 128_000, true, 50_000,
      );
      expect(compactTriggered).toBe(true);
    });

    it('compact failure is caught and surfaced as error', () => {
      // When compact throws, the orchestrator catches it and re-estimates.
      // Tokens are unchanged after the failed compact, so the result is 'error'.
      // We model this by passing tokensAfterCompact = estimatedTokens (no reduction).
      const estimatedTokens = 150_000;
      const { result, compactTriggered } = simulatePreflightCheck(
        estimatedTokens,
        128_000,
        true,
        estimatedTokens, // compact threw — token count unchanged
      );
      expect(result).toBe('error');
      expect(compactTriggered).toBe(true);
    });
  });

  describe('request exceeding context — auto-compact disabled', () => {
    it('returns error immediately without triggering compact', () => {
      const { result, compactTriggered } = simulatePreflightCheck(
        150_000, 128_000,
        false,   // auto-compact off
        60_000,
      );
      expect(result).toBe('error');
      expect(compactTriggered).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Error message format
// ---------------------------------------------------------------------------

/**
 * Mirrors emitContextOverflowError's message-building logic.
 * Tests that the required elements appear in the error string.
 */
function buildOverflowMessage(
  estimatedTokens: number,
  contextWindow: number,
  modelDisplayName: string,
  alternatives: CatalogModelEntry[],
): string {
  const requestK = Math.round(estimatedTokens / 1000);
  const contextK = Math.round(contextWindow / 1000);

  let msg =
    `Request (~${requestK}K tokens) exceeds ${modelDisplayName} context window (${contextK}K). ` +
    `Use /compact to reduce context or switch to a larger model.`;

  if (alternatives.length > 0) {
    const altNames = alternatives
      .map(a => `${a.displayName} (${Math.round(a.context / 1000)}K)`)
      .join(', ');
    msg += ` Larger-context alternatives: ${altNames}.`;
  }

  return msg;
}

describe('context overflow error message', () => {
  it('includes request token count in K', () => {
    const msg = buildOverflowMessage(180_000, 128_000, 'Test Model', []);
    expect(msg).toContain('~180K tokens');
  });

  it('includes model name in error', () => {
    const msg = buildOverflowMessage(180_000, 128_000, 'Claude Sonnet 4.5', []);
    expect(msg).toContain('Claude Sonnet 4.5');
  });

  it('includes context window size in K', () => {
    const msg = buildOverflowMessage(180_000, 128_000, 'Test Model', []);
    expect(msg).toContain('128K');
  });

  it('includes /compact suggestion', () => {
    const msg = buildOverflowMessage(180_000, 128_000, 'Test Model', []);
    expect(msg).toContain('/compact');
  });

  it('does not include alternatives section when none available', () => {
    const msg = buildOverflowMessage(180_000, 128_000, 'Test Model', []);
    expect(msg).not.toContain('alternatives');
  });

  it('includes alternatives when provided', () => {
    const alternatives: CatalogModelEntry[] = [
      { id: 'gpt-5', displayName: 'GPT-5', provider: 'openai', context: 256_000, tier: 'paid' },
      { id: 'gemini-3', displayName: 'Gemini 3', provider: 'google', context: 1_000_000, tier: 'paid' },
    ];
    const msg = buildOverflowMessage(180_000, 128_000, 'Test Model', alternatives);
    expect(msg).toContain('Larger-context alternatives');
    expect(msg).toContain('GPT-5');
    expect(msg).toContain('Gemini 3');
  });

  it('formats alternative context sizes in K', () => {
    const alternatives: CatalogModelEntry[] = [
      { id: 'big-model', displayName: 'Big Model', provider: 'test', context: 256_000, tier: 'paid' },
    ];
    const msg = buildOverflowMessage(180_000, 128_000, 'Test Model', alternatives);
    expect(msg).toContain('256K');
  });

  it('handles rounding — 130500 tokens rounds to 131K', () => {
    const msg = buildOverflowMessage(130_500, 128_000, 'Model X', []);
    // Math.round(130500 / 1000) = 131
    expect(msg).toContain('~131K tokens');
  });
});

// ---------------------------------------------------------------------------
// findLargerContextModels alternative suggestion
// ---------------------------------------------------------------------------

describe('alternative model suggestion', () => {
  it('findLargerContextModels filters by tier when specified', () => {
    // Build a mock catalog to test tier filtering in isolation
    const mockCatalog: ModelCatalog = {
      getModel: () => null,
      findLargerContextModels: (
        minContext: number,
        tier?: 'free' | 'paid' | 'subscription',
        limit = 3,
      ): CatalogModelEntry[] => {
        const all: CatalogModelEntry[] = [
          { id: 'free-big', displayName: 'Free Big', provider: 'p1', context: 256_000, tier: 'free' },
          { id: 'paid-big', displayName: 'Paid Big', provider: 'p2', context: 256_000, tier: 'paid' },
          { id: 'sub-big', displayName: 'Sub Big', provider: 'p3', context: 256_000, tier: 'subscription' },
        ];
        return all
          .filter(e => e.context > minContext && (tier === undefined || e.tier === tier))
          .slice(0, limit);
      },
    };

    const freeResults = mockCatalog.findLargerContextModels(128_000, 'free');
    expect(freeResults.every(m => m.tier === 'free')).toBe(true);
    expect(freeResults.length).toBe(1);

    const paidResults = mockCatalog.findLargerContextModels(128_000, 'paid');
    expect(paidResults.every(m => m.tier === 'paid')).toBe(true);
    expect(paidResults.length).toBe(1);
  });

  it('returns empty array when no models have larger context', () => {
    const mockCatalog: ModelCatalog = {
      getModel: () => null,
      findLargerContextModels: () => [],
    };
    const results = mockCatalog.findLargerContextModels(1_000_000);
    expect(results).toEqual([]);
    // Error message should not mention alternatives
    const msg = buildOverflowMessage(1_200_000, 1_000_000, 'Giant Model', results);
    expect(msg).not.toContain('alternatives');
  });

  it('suggests up to 3 alternatives by default', () => {
    const mockCatalog: ModelCatalog = {
      getModel: () => null,
      findLargerContextModels: (
        _minContext: number,
        _tier?: 'free' | 'paid' | 'subscription',
        limit = 3,
      ): CatalogModelEntry[] => {
        const pool: CatalogModelEntry[] = Array.from({ length: 10 }, (_, i) => ({
          id: `model-${i}`,
          displayName: `Model ${i}`,
          provider: 'test',
          context: 256_000 + i * 1000,
          tier: 'paid' as const,
        }));
        return pool.slice(0, limit);
      },
    };

    const results = mockCatalog.findLargerContextModels(128_000, undefined, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
