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

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  SyntheticProvider,
} from '@pellux/goodvibes-sdk/platform/providers';
import type { CanonicalModel } from '@pellux/goodvibes-sdk/platform/providers';
import type { BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types';
import type { ChatRequest, ChatResponse, LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';

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
  stopReason: 'completed',
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

/** Create a mock provider that throws a non-rate-limit client error (4xx, not 429). Defaults to 400 Bad Request. */
function mockClientError(name: string, msg = 'bad request', status = 400): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      throw new ProviderError(msg, status);
    },
  };
}

/** Create a mock provider that throws a server error (5xx) — should failover. */
function mockServerError(name: string, msg = 'internal server error', status = 500): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      throw new ProviderError(msg, status);
    },
  };
}

/** Create a mock provider that throws a plain network error — should failover. */
function mockNetworkError(name: string, msg = 'ECONNREFUSED'): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      throw new Error(msg);
    },
  };
}

/** Create a mock provider that throws a rate-limit error with a short retry-after for fast tests. */
function mockRateLimitFast(name: string): LLMProvider {
  return {
    name,
    models: [],
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      // 'retry-after: 1' is parsed by ProviderError as retryAfterMs = 1000
      throw new ProviderError('rate limited retry-after: 1', 429);
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
    backendCount: 2,
    keyedBackendCount: 1,
  },
  {
    id: 'paid-model-a',
    tier: 'paid',
    backends: [
      { providerName: 'openai', modelId: 'paid-model-a', contextWindow: 128000, envVars: ['OPENAI_API_KEY'] },
    ],
    backendCount: 1,
    keyedBackendCount: 1,
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
    backendCount: 1,
    keyedBackendCount: 0,
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
    backendCount: 3,
    keyedBackendCount: 3,
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
    backendCount: 1,
    keyedBackendCount: 1,
  },
  {
    id: 'high-score-model',
    tier: 'free',
    backends: [
      { providerName: 'provider-b', modelId: 'high-score-model', contextWindow: 128000, envVars: [] },
    ],
    backendCount: 1,
    keyedBackendCount: 1,
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
    backendCount: 2,
    keyedBackendCount: 2,
  },
];

// ---------------------------------------------------------------------------
// Registry mock: dynamic map from providerName -> LLMProvider
// ---------------------------------------------------------------------------

const registryMap = new Map<string, LLMProvider>();
let catalogModels: CanonicalModel[] = [];
let benchmarkEntries = new Map<string, BenchmarkEntry>();

function makeSyntheticProvider(): SyntheticProvider {
  return new SyntheticProvider({
    resolveProvider: (name: string) => {
      const provider = registryMap.get(name);
      if (!provider) throw new Error(`Provider not found: ${name}`);
      return provider;
    },
    getCatalogModels: () => catalogModels,
    getBenchmarks: (modelName: string) => benchmarkEntries.get(modelName),
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  registryMap.clear();
  catalogModels = [];
  benchmarkEntries = new Map();
});

afterEach(() => {
  process.env = originalEnv;
  registryMap.clear();
  catalogModels = [];
  benchmarkEntries = new Map();
});

// ---------------------------------------------------------------------------
// Tier isolation
// ---------------------------------------------------------------------------

describe('tier isolation', () => {
  it('free model only uses free-tier backends', async () => {
    catalogModels = CATALOG_TIER_ISOLATION;
    // Clear env and set only HF_TOKEN — ensures huggingface is keyed, nvidia is not
    process.env = { HF_TOKEN: 'hf-test-key' };
    registryMap.set('huggingface', mockOk('huggingface'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'free-model-a' });
    expect(response.content).toBe('huggingface/ok');
  });

  it('paid model uses only paid-tier backends', async () => {
    catalogModels = CATALOG_TIER_ISOLATION;
    process.env = { OPENAI_API_KEY: 'sk-test' };
    registryMap.set('openai', mockOk('openai'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'paid-model-a' });
    expect(response.content).toBe('openai/ok');
  });

  it('free model does NOT fall over to paid backend even if paid has keys', async () => {
    catalogModels = CATALOG_TIER_ISOLATION;
    // Clear ALL env vars and only set the paid key, so free-tier backends have no keys
    process.env = { OPENAI_API_KEY: 'sk-test' };
    registryMap.set('openai', mockOk('openai'));

    const provider = makeSyntheticProvider();
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
    catalogModels = CATALOG_TIER_ISOLATION;
    // Clear env and set only NVIDIA key — ensures nvidia is keyed, huggingface is not
    process.env = { NVIDIA_API_KEY: 'nv-test-key' };
    registryMap.set('nvidia', mockOk('nvidia'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'free-model-a' });
    expect(response.content).toBe('nvidia/ok');
  });

  it('throws clear error when zero backends have keys', async () => {
    catalogModels = CATALOG_NO_KEYS;
    // LOCKED_API_KEY not set

    const provider = makeSyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'locked-model' }),
    ).rejects.toThrow('No API keys configured for any provider offering locked-model');
  });

  it('backends with empty envVars (no key required) are always included', async () => {
    catalogModels = CATALOG_SORT_ORDER;
    registryMap.set('large-ctx', mockOk('large-ctx'));
    registryMap.set('medium-ctx', mockOk('medium-ctx'));
    registryMap.set('small-ctx', mockOk('small-ctx'));

    const provider = makeSyntheticProvider();
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
    catalogModels = CATALOG_SORT_ORDER;
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

    const provider = makeSyntheticProvider();
    await provider.chat({ ...DUMMY_REQUEST, model: 'sort-test-model' });
    expect(firstCalled as unknown as string).toBe('large-ctx');
  });

  it('uses maxOutputTokens as tiebreaker when contextWindow is equal', async () => {
    catalogModels = [
      {
        id: 'tie-model',
        tier: 'free',
        backends: [
          { providerName: 'low-output',  modelId: 'tie', contextWindow: 100000, maxOutputTokens: 4096,  envVars: [] },
          { providerName: 'high-output', modelId: 'tie', contextWindow: 100000, maxOutputTokens: 32768, envVars: [] },
        ],
        backendCount: 2,
        keyedBackendCount: 2,
      },
    ];

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

    const provider = makeSyntheticProvider();
    await provider.chat({ ...DUMMY_REQUEST, model: 'tie-model' });
    expect(firstCalled as unknown as string).toBe('high-output');
  });
});

// ---------------------------------------------------------------------------
// Zero-key error message
// ---------------------------------------------------------------------------

describe('zero-key error message', () => {
  it('error message names the model', async () => {
    catalogModels = CATALOG_NO_KEYS;

    const provider = makeSyntheticProvider();
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
    catalogModels = [];

    const provider = makeSyntheticProvider();
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
    catalogModels = CATALOG_BEST_FREE;

    // Inject benchmark data: high-score-model has SWE=0.9, low-score-model has SWE=0.3
    benchmarkEntries = new Map([
      [
        'low-score-model',
        {
          modelId: 'low-score-model',
          name: 'Low Score Model',
          organization: 'test',
          benchmarks: { swe: 0.3, gpqa: 0.3 },
        },
      ],
      [
        'high-score-model',
        {
          modelId: 'high-score-model',
          name: 'High Score Model',
          organization: 'test',
          benchmarks: { swe: 0.9, gpqa: 0.9 },
        },
      ],
    ]);

    // Both providers have no key requirement (envVars: [])
    registryMap.set('provider-a', mockOk('provider-a'));
    registryMap.set('provider-b', mockOk('provider-b'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'best-free' });
    // provider-b backs high-score-model — should be selected
    expect(response.content).toBe('provider-b/ok');
  });

  it('throws when no free models have keys', async () => {
    catalogModels = [
      {
        id: 'keyed-free-model',
        tier: 'free',
        backends: [
          { providerName: 'locked', modelId: 'keyed-free-model', contextWindow: 100000, envVars: ['MISSING_KEY'] },
        ],
        backendCount: 1,
        keyedBackendCount: 0,
      },
    ];

    const provider = makeSyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'best-free' }),
    ).rejects.toThrow('No API keys configured for any provider offering free models');
  });

  it('falls back to model without benchmark data when it is the only keyed option', async () => {
    catalogModels = [
      {
        id: 'no-benchmark-model',
        tier: 'free',
        backends: [
          { providerName: 'provider-c', modelId: 'no-benchmark-model', contextWindow: 128000, envVars: [] },
        ],
        backendCount: 1,
        keyedBackendCount: 1,
      },
    ];
    benchmarkEntries = new Map(); // no benchmark data
    registryMap.set('provider-c', mockOk('provider-c'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'best-free' });
    expect(response.content).toBe('provider-c/ok');
  });
});

// ---------------------------------------------------------------------------
// Failover within tier
// ---------------------------------------------------------------------------

describe('failover within tier', () => {
  it('falls over to next backend when first is rate-limited', async () => {
    catalogModels = CATALOG_FAILOVER;
    registryMap.set('rate-limited-provider', mockRateLimit('rate-limited-provider'));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });

  it('does NOT fall over for 400 Bad Request (malformed request)', async () => {
    catalogModels = CATALOG_FAILOVER;
    // 400 Bad Request means the request itself is malformed — re-throw immediately, no failover
    registryMap.set('rate-limited-provider', mockClientError('rate-limited-provider', 'bad request', 400));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    await expect(
      provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' }),
    ).rejects.toThrow('bad request');
  });

  it('fails over on 401 auth errors (provider-specific, not malformed request)', async () => {
    catalogModels = CATALOG_FAILOVER;
    // 401 Unauthorized is provider-specific — invalid key for this backend, try next
    registryMap.set('rate-limited-provider', mockClientError('rate-limited-provider', 'unauthorized', 401));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });

  it('fails over on 403 billing/forbidden errors (provider-specific)', async () => {
    catalogModels = CATALOG_FAILOVER;
    // 403 Forbidden (e.g. insufficient balance) is provider-specific — failover to next backend
    registryMap.set('rate-limited-provider', mockClientError('rate-limited-provider', 'insufficient balance', 403));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });

  it('throws 429 when all backends are rate-limited', async () => {
    catalogModels = CATALOG_FAILOVER;
    // Use fast rate-limit mocks (retry-after: 1s) so auto-wait completes in ~1.1s
    registryMap.set('rate-limited-provider', mockRateLimitFast('rate-limited-provider'));
    registryMap.set('ok-provider', mockRateLimitFast('ok-provider'));

    const provider = makeSyntheticProvider();
    let thrown: ProviderError | null = null;
    try {
      await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    } catch (err) {
      thrown = err as ProviderError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.statusCode).toBe(429);
    expect(thrown!.message).toContain('failover-model');
  }, 5000);

  it('fails over on 500 server errors', async () => {
    catalogModels = CATALOG_FAILOVER;
    // 500 is a transient server error — should failover to next backend
    registryMap.set('rate-limited-provider', mockServerError('rate-limited-provider', 'server error', 500));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });

  it('fails over on network errors (plain Error, not ProviderError)', async () => {
    catalogModels = CATALOG_FAILOVER;
    // Plain Error (e.g. ECONNREFUSED) is a transient error — should failover to next backend
    registryMap.set('rate-limited-provider', mockNetworkError('rate-limited-provider', 'ECONNREFUSED'));
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });

  it('skips unavailable providers (registry miss) and tries next', async () => {
    catalogModels = CATALOG_FAILOVER;
    // rate-limited-provider not in registry (simulates provider not registered)
    registryMap.set('ok-provider', mockOk('ok-provider'));

    const provider = makeSyntheticProvider();
    const response = await provider.chat({ ...DUMMY_REQUEST, model: 'failover-model' });
    expect(response.content).toBe('ok-provider/ok');
  });
});
