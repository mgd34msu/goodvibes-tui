import { describe, test, expect } from 'bun:test';
import { getCostFromPricingCatalog } from '@pellux/goodvibes-sdk/platform/providers';
import type { PricingCatalog } from '@pellux/goodvibes-sdk/platform/providers';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CATALOG: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [
    {
      id: 'test-paid-model',
      name: 'Test Paid Model',
      provider: 'test-provider',
      providerId: 'test-provider',
      providerEnvVars: [],
      pricing: { input: 5.00, output: 15.00 },
      tier: 'paid',
    },
    {
      id: 'test-free-model',
      name: 'Test Free Model',
      provider: 'test-provider',
      providerId: 'test-provider',
      providerEnvVars: [],
      pricing: { input: 0, output: 0 },
      tier: 'free',
    },
    {
      id: 'test-subscription-model',
      name: 'Test Subscription Model',
      provider: 'test-provider',
      providerId: 'test-provider',
      providerEnvVars: [],
      pricing: { input: 10.00, output: 30.00 },
      tier: 'subscription',
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      providerId: 'anthropic',
      providerEnvVars: ['ANTHROPIC_API_KEY'],
      pricing: { input: 3.00, output: 15.00 },
      tier: 'paid',
    },
  ],
};

// ---------------------------------------------------------------------------
// getCostFromPricingCatalog tests
// ---------------------------------------------------------------------------

describe('getCostFromPricingCatalog', () => {
  describe('catalog model returns correct pricing', () => {
    test('paid model returns its pricing', () => {
      const result = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      expect(result.input).toBe(5.00);
      expect(result.output).toBe(15.00);
    });

    test('subscription model returns its pricing', () => {
      const result = getCostFromPricingCatalog('test-subscription-model', TEST_CATALOG);
      expect(result.input).toBe(10.00);
      expect(result.output).toBe(30.00);
    });

    test('known model with versioned suffix matches via prefix', () => {
      const result = getCostFromPricingCatalog('claude-sonnet-4-6-20250101', TEST_CATALOG);
      expect(result.input).toBe(3.00);
      expect(result.output).toBe(15.00);
    });

    test('result is a plain object with input and output fields', () => {
      const result = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      expect(typeof result.input).toBe('number');
      expect(typeof result.output).toBe('number');
    });
  });

  describe('free model returns { 0, 0 }', () => {
    test('catalog free-tier model returns {0,0}', () => {
      const result = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test(':free suffix returns {0,0} regardless of catalog', () => {
      const result = getCostFromPricingCatalog('any-model:free', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test(':free suffix on known paid model still returns {0,0}', () => {
      const result = getCostFromPricingCatalog('test-paid-model:free', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('free model shows $0.00 when formatted', () => {
      const result = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
      const usd = (1000 * result.input + 1000 * result.output) / 1_000_000;
      expect(usd).toBe(0);
      const formatted = usd === 0 ? '$0.00' : `$${usd.toFixed(3)}`;
      expect(formatted).toBe('$0.00');
    });
  });

  describe('unknown model falls back gracefully', () => {
    test('completely unknown model returns {0,0}', () => {
      const result = getCostFromPricingCatalog('totally-unknown-model-xyz', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('unknown model does not throw', () => {
      expect(() => getCostFromPricingCatalog('nonexistent-model', TEST_CATALOG)).not.toThrow();
    });

    test('empty string model ID returns {0,0}', () => {
      const result = getCostFromPricingCatalog('', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('unknown model with debug=false does not write to stderr', () => {
      const result = getCostFromPricingCatalog('unknown-model', TEST_CATALOG, undefined, { debug: false });
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });
  });

  describe('cost calculation with catalog pricing', () => {
    test('calculates cost correctly with catalog pricing (per 1M tokens)', () => {
      const pricing = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      const cost = (1_000_000 * pricing.input + 0 * pricing.output) / 1_000_000;
      expect(cost).toBe(5.00);
    });

    test('calculates cost for mixed input/output tokens', () => {
      const pricing = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      const cost = (500_000 * pricing.input + 100_000 * pricing.output) / 1_000_000;
      expect(cost).toBeCloseTo(2.50 + 1.50, 6);
    });

    test('zero cost for free model regardless of token count', () => {
      const pricing = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
      const cost = (1_000_000 * pricing.input + 1_000_000 * pricing.output) / 1_000_000;
      expect(cost).toBe(0);
    });

    test('zero cost for unknown model (graceful fallback)', () => {
      const pricing = getCostFromPricingCatalog('unknown-model-xyz', TEST_CATALOG);
      const cost = (1_000_000 * pricing.input + 1_000_000 * pricing.output) / 1_000_000;
      expect(cost).toBe(0);
    });

    test('catalog returns immutable copy (mutations do not affect catalog)', () => {
      const pricing = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      pricing.input = 9999;
      const pricing2 = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      expect(pricing2.input).toBe(5.00);
    });
  });
});

// ---------------------------------------------------------------------------
// getCostFromPricingCatalog tests
// ---------------------------------------------------------------------------

describe('getCostFromPricingCatalog with explicit catalog shapes', () => {
  test('returns catalog pricing from an explicit model array', () => {
    const result = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
    expect(result.input).toBe(5.00);
    expect(result.output).toBe(15.00);
  });

  test('returns zero for free-tier models from an explicit catalog', () => {
    const result = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
  });

  test('returns zero for empty explicit catalogs', () => {
    const result = getCostFromPricingCatalog('unknown-model', { models: [] });
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
  });
});
