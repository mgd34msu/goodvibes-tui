/**
 * synthetic-catalog.test.ts
 *
 * Tests for Stage 3: Catalog-driven SyntheticProvider.
 * Covers:
 *   - Tier isolation: free model only uses free backends
 *   - Key filtering: backends without keys are skipped
 *   - Backend sort order: context desc, then maxOutput desc
 *   - Zero-key error message
 *   - best-free resolves to highest-scored free model with keys
 *   - Failover within tier (rate-limit triggers next backend)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  SyntheticProvider,
  _setSyntheticCatalogForTest,
  _resetSyntheticCatalog,
} from '../../providers/synthetic.ts';
import type { CanonicalModel } from '../../providers/synthetic.ts';
import { _setEntriesForTest } from '../../providers/model-benchmarks.ts';
import { ProviderError } from '../../types/errors.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../../providers/interface.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DUMMY_REQUEST: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
};

const DUMMY_RESPONSE: ChatResponse = {
  content: 'ok',
  toolCalls: [],
  usage: { inputTokens: 5, outputTokens: 3 },
  stopReason: 'end',
};

/** Create a mock provider that always succeeds. Encodes provider name in content. */
function mockOk(name: string): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      ...DUMMY_RESPONSE,
      content: `${name}/ok`,
    }),
  };
}

/** Create a mock provider that throws a rate-limit ProviderError. */
function mockRateLimit(name: string): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      throw new ProviderError('rate limited', 429);
    },
  };
}

/** Create a mock provider that throws a non-rate-limit error. */
function mockError(name: string, msg = 'fatal error'): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      throw new ProviderError(msg, 500);
    },
  };
}

// ---------------------------------------------------------------------------
// Test catalog fixtures
// ---------------------------------------------------------------------------

/** Two free backends: huggingface (262K) then nvidia (131K). nvidia has no key. */
const CATALOG_TIER_ISOLATION: CanonicalModel[] = [
  {
    id: 'free-model-a',
    tier: 'free',
    backends: [
      { providerName: 'huggingface', modelId: 'org/free-model-a', contextWindow: 262144, envVars: ['HF_TOKEN'] },
      { providerName: 'nvidia',      modelId: 'org/free-model-a', contextWindow: 131072, envVars: ['NVIDIA_API_KEY'] },
    ],
  },
  {
    id: 'paid-model-a',
    tier: 'paid',
    backends: [
      { providerName: 'openai', modelId: 'paid-model-a', contextWindow: 128000, envVars: ['OPENAI_API_KEY'] },
    ],
  },
];

/** Model with no backends that have keys configured. */
const CATALOG_NO_KEYS: CanonicalModel[] = [
  {
    id: 'locked-model',
    tier: 'free',
    backends: [
      { providerName: 'locked-provider', modelId: 'locked/model', contextWindow: 100000, envVars: ['LOCKED_API_KEY'] },
    ],
  },
];

/** Backends with different context windows for sort-order test. */
const CATALOG_SORT_ORDER: CanonicalModel[] = [
  {
    id: 'sort-test-model',
    tier: 'free',
    backends: [
      // Intentionally listed out-of-order; should be sorted ctx desc
      { providerName: 'small-ctx',   modelId: 'small',  contextWindow: 32768,   maxOutputTokens: 8192,  envVars: [] },
      { providerName: 'large-ctx',   modelId: 'large',  contextWindow: 1000000, maxOutputTokens: 32768, envVars: [] },
      { providerName: 'medium-ctx',  modelId: 'medium', contextWindow: 262144,  maxOutputTokens: 16384, envVars: [] },
    ],
  },
];

/** Two free models with benchmark data for best-free test. */
const CATALOG_BEST_FREE: CanonicalModel[] = [
  {
    id: 'low-score-model',
    tier: 'free',
    backends: [
      { providerName: 'provider-a', modelId: 'low-score-model', contextWindow: 128000, envVars: [] },
    ],
  },
  {
    id: 'high-score-model',
    tier: 'free',
    backends: [
      { providerName: 'provider-b', modelId: 'high-score-model', contextWindow: 128000, envVars: [] },
    ],
  },
];

/** Failover: first backend rate-limits, second succeeds. */
const CATALOG_FAILOVER: CanonicalModel[] = [
  {
    id: 'failover-model',
    tier: 'free',
    backends: [
      { providerName: 'rate-limited-provider', modelId: 'failover-model', contextWindow: 100000, envVars: [] },
      { providerName: 'ok-provider',           modelId: 'failover-model', contextWindow: 100000, envVars: [] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Registry mock: dynamic map from providerName -> LLMProvider
// ---------------------------------------------------------------------------

// We intercept the dynamic import of registry.ts inside SyntheticProvider.chat()
// by mocking the module. Bun supports mock.module for this purpose.

const registryMap = new Map<string, LLMProvider>();

mock.module('../../providers/registry.ts', () => ({
  providerRegistry: {
    get: (name: string): LLMProvider => {
      const p = registryMap.get(name);
      if (!p) throw new Error(`Provider not found: ${name}`);
      return p;
    },
  },
}));

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  registryMap.clear();
  _setEntriesForTest([]);
});

afterEach(() => {
  process.env = originalEnv;
  registryMap.clear();
  _resetSyntheticCatalog();
  _setEntriesForTest([]);
});

// ---------------------------------------------------------------------------
// Tier isolation
// ---------------------------------------------------------------------------

describe('tier isolation', () => {
  it('free model only uses free-tier backends', async () => {
    _setSyntheticCatalogForTest(CATALOG_TIER_ISOLATION);
    // Clear env and set only HF_TOKEN — ensures huggingface is keyed, nvidia is not
    process.env = { HF_TOKEN: 'hf-test-key' };
    registryMap.set('huggingface', mockOk('huggingface'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'free-model-a' });
    expect(response.content).toBe('huggingface/ok');
  });

  it('paid model uses only paid-tier backends', async () => {
    _setSyntheticCatalogForTest(CATALOG_TIER_ISOLATION);
    process.env = { OPENAI_API_KEY: 'sk-test' };
    registryMap.set('openai', mockOk('openai'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'paid-model-a' });
    expect(response.content).toBe('openai/ok');
  });

  it('free model does NOT fall over to paid backend even if paid has keys', async () => {
    _setSyntheticCatalogForTest(CATALOG_TIER_ISOLATION);
    // Clear ALL env vars and only set the paid key, so free-tier backends have no keys
    process.env = { OPENAI_API_KEY: 'sk-test' };
    registryMap.set('openai', mockOk('openai'));

    const provider = new SyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'free-model-a' }),
    ).rejects.toThrow('No API keys configured for any provider offering free-model-a');
  });
});

// ---------------------------------------------------------------------------
// Key filtering
// ---------------------------------------------------------------------------

describe('key filtering', () => {
  it('skips backends that lack a configured API key', async () => {
    _setSyntheticCatalogForTest(CATALOG_TIER_ISOLATION);
    // Clear env and set only NVIDIA key — ensures nvidia is keyed, huggingface is not
    process.env = { NVIDIA_API_KEY: 'nv-test-key' };
    registryMap.set('nvidia', mockOk('nvidia'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'free-model-a' });
    expect(response.content).toBe('nvidia/ok');
  });

  it('throws clear error when zero backends have keys', async () => {
    _setSyntheticCatalogForTest(CATALOG_NO_KEYS);
    // LOCKED_API_KEY not set

    const provider = new SyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'locked-model' }),
    ).rejects.toThrow('No API keys configured for any provider offering locked-model');
  });

  it('backends with empty envVars (no key required) are always included', async () => {
    _setSyntheticCatalogForTest(CATALOG_SORT_ORDER);
    registryMap.set('large-ctx', mockOk('large-ctx'));
    registryMap.set('medium-ctx', mockOk('medium-ctx'));
    registryMap.set('small-ctx', mockOk('small-ctx'));

    const provider = new SyntheticProvider();
    // Should succeed because envVars: [] means no key required
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'sort-test-model' });
    // large-ctx has the highest context window, so it should be tried first
    expect(response.content).toBe('large-ctx/ok');
  });
});

// ---------------------------------------------------------------------------
// Backend sort order
// ---------------------------------------------------------------------------

describe('backend sort order (context desc)', () => {
  it('tries backend with largest context window first', async () => {
    _setSyntheticCatalogForTest(CATALOG_SORT_ORDER);
    let firstCalled: string | null = null;

    const makeMock = (name: string): LLMProvider => ({
      name,
      models: [],
      chat: async (_req: ChatRequest): Promise<ChatResponse> => {
        if (!firstCalled) firstCalled = name;
        return { ...DUMMY_RESPONSE, content: `${name}/ok` };
      },
    });

    registryMap.set('large-ctx', makeMock('large-ctx'));
    registryMap.set('medium-ctx', makeMock('medium-ctx'));
    registryMap.set('small-ctx', makeMock('small-ctx'));

    const provider = new SyntheticProvider();
    await provider.chat({ ...DUMMY_REQUEST, model: 'sort-test-model' });
    expect(firstCalled).toBe('large-ctx');
  });

  it('uses maxOutputTokens as tiebreaker when contextWindow is equal', async () => {
    _setSyntheticCatalogForTest([
      {
        id: 'tie-model',
        tier: 'free',
        backends: [
          { providerName: 'low-output',  modelId: 'tie', contextWindow: 100000, maxOutputTokens: 4096,  envVars: [] },
          { providerName: 'high-output', modelId: 'tie', contextWindow: 100000, maxOutputTokens: 32768, envVars: [] },
        ],
      },
    ]);

    let firstCalled: string | null = null;
    const makeMock = (name: string): LLMProvider => ({
      name,
      models: [],
      chat: async (_req: ChatRequest): Promise<ChatResponse> => {
        if (!firstCalled) firstCalled = name;
        return { ...DUMMY_RESPONSE, content: `${name}/ok` };
      },
    });

    registryMap.set('low-output', makeMock('low-output'));
    registryMap.set('high-output', makeMock('high-output'));

    const provider = new SyntheticProvider();
    await provider.chat({ ...DUMMY_REQUEST, model: 'tie-model' });
    expect(firstCalled).toBe('high-output');
  });
});

// ---------------------------------------------------------------------------
// Zero-key error message
// ---------------------------------------------------------------------------

describe('zero-key error message', () => {
  it('error message names the model', async () => {
    _setSyntheticCatalogForTest(CATALOG_NO_KEYS);

    const provider = new SyntheticProvider();
    let thrown: Error | null = null;
    try {
      await provider.chat({ ...DUMMY_REQUEST, model: 'locked-model' });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('locked-model');
    expect(thrown!.message).toContain('No API keys configured for any provider offering');
  });

  it('unknown model throws different error', async () => {
    _setSyntheticCatalogForTest([]);

    const provider = new SyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'does-not-exist' }),
    ).rejects.toThrow('Unknown synthetic model: does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// best-free resolution
// ---------------------------------------------------------------------------

describe('best-free synthetic model', () => {
  it('resolves to the highest SWE-bench scored free model with keys', async () => {
    _setSyntheticCatalogForTest(CATALOG_BEST_FREE);

    // Inject benchmark data: high-score-model has SWE=0.9, low-score-model has SWE=0.3
    _setEntriesForTest([
      {
        modelId: 'low-score-model',
        name: 'Low Score Model',
        organization: 'test',
        benchmarks: { swe: 0.3, gpqa: 0.3 },
      },
      {
        modelId: 'high-score-model',
        name: 'High Score Model',
        organization: 'test',
        benchmarks: { swe: 0.9, gpqa: 0.9 },
      },
    ]);

    // Both providers have no key requirement (envVars: [])
    registryMap.set('provider-a', mockOk('provider-a'));
    registryMap.set('provider-b', mockOk('provider-b'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'best-free' });
    // provider-b backs high-score-model — should be selected
    expect(response.content).toBe('provider-b/ok');
  });

  it('throws when no free models have keys', async () => {
    _setSyntheticCatalogForTest([
      {
        id: 'keyed-free-model',
        tier: 'free',
        backends: [
          { providerName: 'locked', modelId: 'keyed-free-model', contextWindow: 100000, envVars: ['MISSING_KEY'] },
        ],
      },
    ]);

    const provider = new SyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'best-free' }),
    ).rejects.toThrow('No API keys configured for any provider offering free models');
  });

  it('falls back to model without benchmark data when it is the only keyed option', async () => {
    _setSyntheticCatalogForTest([
      {
        id: 'no-benchmark-model',
        tier: 'free',
        backends: [
          { providerName: 'provider-c', modelId: 'no-benchmark-model', contextWindow: 128000, envVars: [] },
        ],
      },
    ]);
    _setEntriesForTest([]); // no benchmark data
    registryMap.set('provider-c', mockOk('provider-c'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'best-free' });
    expect(response.content).toBe('provider-c/ok');
  });
});

// ---------------------------------------------------------------------------
// Failover within tier
// ---------------------------------------------------------------------------

describe('failover within tier', () => {
  it('falls over to next backend when first is rate-limited', async () => {
    _setSyntheticCatalogForTest(CATALOG_FAILOVER);
    registryMap.set('rate-limited-provider', mockRateLimit('rate-limited-provider'));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });

  it('does NOT fall over for non-rate-limit errors', async () => {
    _setSyntheticCatalogForTest(CATALOG_FAILOVER);
    registryMap.set('rate-limited-provider', mockError('rate-limited-provider', 'internal server error'));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = new SyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' }),
    ).rejects.toThrow('internal server error');
  });

  it('throws 429 when all backends are rate-limited', async () => {
    _setSyntheticCatalogForTest(CATALOG_FAILOVER);
    registryMap.set('rate-limited-provider', mockRateLimit('rate-limited-provider'));
    registryMap.set('ok-provider', mockRateLimit('ok-provider'));

    const provider = new SyntheticProvider();
    let thrown: ProviderError | null = null;
    try {
      await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    } catch (err) {
      thrown = err as ProviderError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.statusCode).toBe(429);
    expect(thrown!.message).toContain('failover-model');
  });

  it('skips unavailable providers (registry miss) and tries next', async () => {
    _setSyntheticCatalogForTest(CATALOG_FAILOVER);
    // rate-limited-provider not in registry (simulates provider not registered)
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = new SyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });
});
