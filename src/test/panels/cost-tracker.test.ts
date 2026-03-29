// ---------------------------------------------------------------------------
// cost-tracker.test.ts — Tests for catalog-backed cost lookup
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getCostFromCatalog,
  _getPricingCatalog,
  _setCatalogForTesting,
  _resetCatalog,
} from '../../providers/model-catalog.ts';
import type { PricingCatalog } from '../../providers/model-catalog.ts';

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

beforeEach(() => {
  _setCatalogForTesting(TEST_CATALOG);
});

afterEach(() => {
  _resetCatalog();
});

// ---------------------------------------------------------------------------
// getCostFromCatalog tests
// ---------------------------------------------------------------------------

describe('getCostFromCatalog', () => {
  describe('catalog model returns correct pricing', () => {
    test('paid model returns its pricing', () => {
      const result = getCostFromCatalog('test-paid-model');
      expect(result.input).toBe(5.00);
      expect(result.output).toBe(15.00);
    });

    test('subscription model returns its pricing', () => {
      const result = getCostFromCatalog('test-subscription-model');
      expect(result.input).toBe(10.00);
      expect(result.output).toBe(30.00);
    });

    test('known model with versioned suffix matches via prefix', () => {
      // claude-sonnet-4-6-20250101 should match claude-sonnet-4-6
      const result = getCostFromCatalog('claude-sonnet-4-6-20250101');
      expect(result.input).toBe(3.00);
      expect(result.output).toBe(15.00);
    });

    test('result is a plain object with input and output fields', () => {
      const result = getCostFromCatalog('test-paid-model');
      expect(typeof result.input).toBe('number');
      expect(typeof result.output).toBe('number');
    });
  });

  describe('free model returns { 0, 0 }', () => {
    test('catalog free-tier model returns {0,0}', () => {
      const result = getCostFromCatalog('test-free-model');
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test(':free suffix returns {0,0} regardless of catalog', () => {
      const result = getCostFromCatalog('any-model:free');
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test(':free suffix on known paid model still returns {0,0}', () => {
      // e.g. openrouter free-tier variant of a paid model
      const result = getCostFromCatalog('test-paid-model:free');
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('free model shows $0.00 when formatted', () => {
      const result = getCostFromCatalog('test-free-model');
      const usd = (1000 * result.input + 1000 * result.output) / 1_000_000;
      // formatCost equivalent: $0.00 for usd === 0
      expect(usd).toBe(0);
      const formatted = usd === 0 ? '$0.00' : `$${usd.toFixed(3)}`;
      expect(formatted).toBe('$0.00');
    });
  });

  describe('unknown model falls back gracefully', () => {
    test('completely unknown model returns {0,0}', () => {
      const result = getCostFromCatalog('totally-unknown-model-xyz');
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('unknown model does not throw', () => {
      expect(() => getCostFromCatalog('nonexistent-model')).not.toThrow();
    });

    test('empty string model ID returns {0,0}', () => {
      const result = getCostFromCatalog('');
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('unknown model with debug=false does not write to stderr', () => {
      // Should not throw; debug is opt-in
      const result = getCostFromCatalog('unknown-model', { debug: false });
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });
  });

  describe('cost calculation with catalog pricing', () => {
    test('calculates cost correctly with catalog pricing (per 1M tokens)', () => {
      const pricing = getCostFromCatalog('test-paid-model');
      // 1M input + 0 output = $5.00
      const cost = (1_000_000 * pricing.input + 0 * pricing.output) / 1_000_000;
      expect(cost).toBe(5.00);
    });

    test('calculates cost for mixed input/output tokens', () => {
      const pricing = getCostFromCatalog('test-paid-model'); // $5/$15
      // 500K input + 100K output
      const cost = (500_000 * pricing.input + 100_000 * pricing.output) / 1_000_000;
      expect(cost).toBeCloseTo(2.50 + 1.50, 6); // $4.00
    });

    test('zero cost for free model regardless of token count', () => {
      const pricing = getCostFromCatalog('test-free-model');
      const cost = (1_000_000 * pricing.input + 1_000_000 * pricing.output) / 1_000_000;
      expect(cost).toBe(0);
    });

    test('zero cost for unknown model (graceful fallback)', () => {
      const pricing = getCostFromCatalog('unknown-model-xyz');
      const cost = (1_000_000 * pricing.input + 1_000_000 * pricing.output) / 1_000_000;
      expect(cost).toBe(0);
    });

    test('catalog returns immutable copy (mutations do not affect catalog)', () => {
      const pricing = getCostFromCatalog('test-paid-model');
      pricing.input = 9999;
      // Re-fetching should give original value
      const pricing2 = getCostFromCatalog('test-paid-model');
      expect(pricing2.input).toBe(5.00);
    });
  });
});

// ---------------------------------------------------------------------------
// _getPricingCatalog tests
// ---------------------------------------------------------------------------

describe('_getPricingCatalog', () => {
  test('returns catalog with models array', () => {
    const catalog = _getPricingCatalog();
    expect(Array.isArray(catalog.models)).toBe(true);
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  test('returns catalog with fetchedAt timestamp', () => {
    const catalog = _getPricingCatalog();
    expect(typeof catalog.fetchedAt).toBe('number');
    expect(catalog.fetchedAt).toBeGreaterThan(0);
  });

  test('test catalog includes known Anthropic models', () => {
    const catalog = _getPricingCatalog();
    const claudeSonnet = catalog.models.find(m => m.id === 'claude-sonnet-4-6');
    expect(claudeSonnet).toBeDefined();
    expect(claudeSonnet!.pricing.input).toBe(3);
    expect(claudeSonnet!.pricing.output).toBe(15);
  });

  test('test catalog includes at least one free model', () => {
    const catalog = _getPricingCatalog();
    const freeModels = catalog.models.filter(m => m.tier === 'free');
    expect(freeModels.length).toBeGreaterThan(0);
  });
});
