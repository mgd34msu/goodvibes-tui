import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import { logger } from '../../utils/logger.ts';
import {
  normalizeModelId,
  hasKeyForProvider,
  getCostFromCatalog,
  getCatalog,
  ensureCacheDir,
  _setCatalogForTesting,
  _resetForTest,
  _nameToSlugForTest,
  _normalizeModelNameForTest,
  _applySyntheticCanonicalModelsForTest,
  _setSyntheticCanonicalSinkForTest,
} from '../../providers/model-catalog.ts';
import type {
  CatalogProvider,
  PricingCatalog,
  CatalogModel,
} from '../../providers/model-catalog.ts';

describe('normalizeModelId', () => {
  it('strips coding- prefix', () => {
    expect(normalizeModelId('coding-glm-4.7-free')).toBe('glm-4.7');
  });
  it('strips -free suffix', () => {
    expect(normalizeModelId('kimi-k2.5-free')).toBe('kimi-k2.5');
  });
  it('strips :free suffix', () => {
    expect(normalizeModelId('nvidia/nemotron-3-super:free')).toBe('nemotron-3-super');
  });
  it('strips provider namespace', () => {
    expect(normalizeModelId('z-ai/glm-4.7-flash')).toBe('glm-4.7-flash');
  });
  it('handles combined coding- prefix and -free suffix', () => {
    expect(normalizeModelId('coding-minimax-m2.1-free')).toBe('minimax-m2.1');
  });
  it('passes through clean IDs unchanged', () => {
    expect(normalizeModelId('gpt-5.2')).toBe('gpt-5.2');
  });
  it('strips openai/ namespace', () => {
    expect(normalizeModelId('openai/gpt-5.2')).toBe('gpt-5.2');
  });
  it('strips meta/ namespace', () => {
    expect(normalizeModelId('meta/llama-3.3-70b')).toBe('llama-3.3-70b');
  });
  it('strips :free from namespaced model', () => {
    expect(normalizeModelId('openai/gpt-4o:free')).toBe('gpt-4o');
  });
  it('does not strip -free- from middle of id', () => {
    const result = normalizeModelId('my-free-model');
    expect(result).not.toBe('my-model');
    expect(result).toBe('my-free-model');
  });
});

describe('hasKeyForProvider', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it('returns true when primary env var is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    const provider: CatalogProvider = { id: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns false when env var is not set', () => {
    delete process.env.OPENAI_API_KEY;
    const provider: CatalogProvider = { id: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'], baseUrl: 'https://api.openai.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(false);
  });
  it('returns false when env var is empty string', () => {
    process.env.GROQ_API_KEY = '';
    const provider: CatalogProvider = { id: 'groq', name: 'Groq', envVars: ['GROQ_API_KEY'], baseUrl: 'https://api.groq.com/openai/v1' };
    expect(hasKeyForProvider(provider)).toBe(false);
  });
  it('checks all fallback env var names', () => {
    delete process.env.NVIDIA_API_KEY;
    process.env.NIM_API_KEY = 'nvapi-test';
    const provider: CatalogProvider = { id: 'nvidia', name: 'NVIDIA', envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'], baseUrl: 'https://integrate.api.nvidia.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns true when any fallback env var is set', () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_HOST;
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const provider: CatalogProvider = { id: 'ollama', name: 'Ollama', envVars: ['OLLAMA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL'], baseUrl: 'http://localhost:11434/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns false when all fallback env vars are absent', () => {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_BASE_URL;
    const provider: CatalogProvider = { id: 'ollama', name: 'Ollama', envVars: ['OLLAMA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL'], baseUrl: 'http://localhost:11434/v1' };
    expect(hasKeyForProvider(provider)).toBe(false);
  });
  it('returns true for providers with no required env vars (self-hosted)', () => {
    const provider: CatalogProvider = { id: 'local-ollama', name: 'Local Ollama', envVars: [], baseUrl: 'http://localhost:11434/v1', requiresKey: false };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
  it('returns true for providers with empty envVars regardless of requiresKey', () => {
    const provider: CatalogProvider = { id: 'subscription-plan', name: 'Subscription Plan', envVars: [], baseUrl: 'https://api.example.com/v1' };
    expect(hasKeyForProvider(provider)).toBe(true);
  });
});

/** Fixture catalog for getCostFromCatalog tests */
const COST_FIXTURE: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', providerId: 'anthropic', providerEnvVars: ['ANTHROPIC_API_KEY'], pricing: { input: 3, output: 15 }, tier: 'paid' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'OpenAI', providerId: 'openai', providerEnvVars: ['OPENAI_API_KEY'], pricing: { input: 0, output: 0 }, tier: 'free' },
  ],
};

describe('getCostFromCatalog', () => {
  beforeEach(() => { _resetForTest(); _setCatalogForTesting(COST_FIXTURE); });

  it('returns zero cost for :free suffix models', () => {
    expect(getCostFromCatalog('openai/gpt-4o:free')).toEqual({ input: 0, output: 0 });
  });
  it('returns correct pricing for exact-match paid model', () => {
    const cost = getCostFromCatalog('claude-sonnet-4-6');
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });
  it('returns zero cost for free-tier models in catalog', () => {
    expect(getCostFromCatalog('gpt-oss-120b')).toEqual({ input: 0, output: 0 });
  });
  it('returns zero cost for unknown models (fallback)', () => {
    expect(getCostFromCatalog('unknown-model-xyz-9999')).toEqual({ input: 0, output: 0 });
  });
  it('handles prefix/substring match for versioned model IDs', () => {
    const cost = getCostFromCatalog('claude-sonnet-4-6-20250101');
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });
  it('respects injected catalog via _setCatalogForTesting', () => {
    const customCatalog: PricingCatalog = {
      fetchedAt: Date.now(),
      models: [{ id: 'test-model', name: 'Test Model', provider: 'test', providerId: 'test', providerEnvVars: [], pricing: { input: 42, output: 84 }, tier: 'paid' }],
    };
    _setCatalogForTesting(customCatalog);
    const cost = getCostFromCatalog('test-model');
    expect(cost.input).toBe(42);
    expect(cost.output).toBe(84);
  });
  it('resets catalog state via _resetForTest', () => {
    const customCatalog: PricingCatalog = {
      fetchedAt: Date.now(),
      models: [{ id: 'test-model', name: 'Test Model', provider: 'test', providerId: 'test', providerEnvVars: [], pricing: { input: 99, output: 99 }, tier: 'paid' }],
    };
    _setCatalogForTesting(customCatalog);
    expect(getCostFromCatalog('test-model').input).toBe(99);
    _resetForTest();
    expect(getCostFromCatalog('test-model')).toEqual({ input: 0, output: 0 });
  });
});

describe('ensureCacheDir', () => {
  it('creates directory when it does not exist', () => {
    const spy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    ensureCacheDir('/tmp/test-cache-dir');
    expect(spy).toHaveBeenCalledWith('/tmp/test-cache-dir', { recursive: true });
    spy.mockRestore();
  });

  it('does not throw when directory already exists (EEXIST)', () => {
    const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const spy = spyOn(fs, 'mkdirSync').mockImplementation(() => { throw eexistError; });
    expect(() => ensureCacheDir('/tmp/existing-dir')).not.toThrow();
    spy.mockRestore();
  });

  it('logs to stderr on unexpected permission error', () => {
    const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => { throw permError; });
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    ensureCacheDir('/root/forbidden');
    expect(warnSpy).toHaveBeenCalled();
    const [message, data] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('[model-catalog]');
    expect((data as Record<string, unknown>).dir).toBe('/root/forbidden');
    mkdirSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('getCatalog', () => {
  it('returns a catalog object with getModel and findLargerContextModels', () => {
    const catalog = getCatalog();
    expect(typeof catalog.getModel).toBe('function');
    expect(typeof catalog.findLargerContextModels).toBe('function');
  });
  it('getModel returns null for unknown model IDs', () => {
    expect(getCatalog().getModel('nonexistent-model-xyz')).toBeNull();
  });
  it('findLargerContextModels returns array', () => {
    expect(Array.isArray(getCatalog().findLargerContextModels(0))).toBe(true);
  });
  it('findLargerContextModels respects limit parameter', () => {
    expect(getCatalog().findLargerContextModels(0, undefined, 2).length).toBeLessThanOrEqual(2);
  });
  it('findLargerContextModels returns results sorted by context descending', () => {
    const results = getCatalog().findLargerContextModels(0, undefined, 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].context).toBeGreaterThanOrEqual(results[i].context);
    }
  });
  it('findLargerContextModels filters by minContext', () => {
    const results = getCatalog().findLargerContextModels(100_000, undefined, 20);
    for (const r of results) {
      expect(r.context).toBeGreaterThan(100_000);
    }
  });
});

// ---------------------------------------------------------------------------
// nameToSlug (slug normalisation)
// ---------------------------------------------------------------------------

describe('nameToSlug (via _nameToSlugForTest)', () => {
  it('lowercases a plain name', () => {
    expect(_nameToSlugForTest('GPT')).toBe('gpt');
  });
  it('strips spaces entirely', () => {
    expect(_nameToSlugForTest('GPT 4o')).toBe('gpt4o');
  });
  it('strips dashes entirely', () => {
    expect(_nameToSlugForTest('GPT-4o')).toBe('gpt4o');
  });
  it('strips underscores entirely', () => {
    expect(_nameToSlugForTest('GPT_4o')).toBe('gpt4o');
  });
  it('GPT-4o, GPT 4o, and GPT_4o all produce the same slug', () => {
    const a = _nameToSlugForTest('GPT-4o');
    const b = _nameToSlugForTest('GPT 4o');
    const c = _nameToSlugForTest('GPT_4o');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('gpt4o');
  });
  it('strips all non-alphanumeric chars including consecutive runs', () => {
    expect(_nameToSlugForTest('hello  --  world')).toBe('helloworld');
  });
  it('strips leading and trailing non-alphanumeric chars', () => {
    expect(_nameToSlugForTest('-leading')).toBe('leading');
    expect(_nameToSlugForTest('trailing-')).toBe('trailing');
  });
  it('handles names with only non-alphanumeric chars', () => {
    expect(_nameToSlugForTest('---')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// normalizeModelName — preserved vs stripped identifiers
// ---------------------------------------------------------------------------

describe('normalizeModelName (via _normalizeModelNameForTest)', () => {
  // --- Preserved identifiers: these MUST produce different slugs ---

  it('mini vs pro: GPT-5.4 Mini and GPT-5.4 Pro yield different slugs', () => {
    const mini = _normalizeModelNameForTest('GPT-5.4 Mini');
    const pro  = _normalizeModelNameForTest('GPT-5.4 Pro');
    expect(mini).not.toBe(pro);
    expect(mini).toBe('gpt54mini');
    expect(pro).toBe('gpt54pro');
  });

  it('version numbers: DeepSeek V3 and DeepSeek V3.1 yield different slugs', () => {
    const v3   = _normalizeModelNameForTest('DeepSeek V3');
    const v31  = _normalizeModelNameForTest('DeepSeek V3.1');
    expect(v3).not.toBe(v31);
    expect(v3).toBe('deepseekv3');
    expect(v31).toBe('deepseekv31');
  });

  it('size indicators: Llama 3.2 1B and Llama 3.2 70B yield different slugs', () => {
    const b1  = _normalizeModelNameForTest('Llama 3.2 1B');
    const b70 = _normalizeModelNameForTest('Llama 3.2 70B');
    expect(b1).not.toBe(b70);
    expect(b1).toBe('llama321b');
    expect(b70).toBe('llama3270b');
  });

  it('thinking vs base: Kimi K2 Thinking and Kimi K2 yield different slugs', () => {
    const thinking = _normalizeModelNameForTest('Kimi K2 Thinking');
    const base     = _normalizeModelNameForTest('Kimi K2');
    expect(thinking).not.toBe(base);
    expect(thinking).toBe('kimik2thinking');
    expect(base).toBe('kimik2');
  });

  it('size indicators resembling dates are preserved: Model 1024B', () => {
    const slug = _normalizeModelNameForTest('Model 1024B');
    expect(slug).toBe('model1024b');
    // 1024 looks like MMDD (Oct 24) but the B suffix makes it a size indicator
    // The \b word boundary in the date regex should prevent matching inside 1024B
  });

  // --- Stripped identifiers: these MUST produce the same slug ---

  it('instruct variant: Kimi K2 Instruct collapses to same slug as Kimi K2', () => {
    const base     = _normalizeModelNameForTest('Kimi K2');
    const instruct = _normalizeModelNameForTest('Kimi K2 Instruct');
    expect(instruct).toBe(base);
    expect(instruct).toBe('kimik2');
  });

  it('chat variant: Model X Chat collapses to same slug as Model X', () => {
    const base = _normalizeModelNameForTest('Model X');
    const chat = _normalizeModelNameForTest('Model X Chat');
    expect(chat).toBe(base);
    expect(chat).toBe('modelx');
  });

  it('quantization: Llama 3.2 70B FP16 and Llama 3.2 70B GPTQ collapse to the same slug', () => {
    const fp16 = _normalizeModelNameForTest('Llama 3.2 70B FP16');
    const gptq = _normalizeModelNameForTest('Llama 3.2 70B GPTQ');
    expect(fp16).toBe(gptq);
    expect(fp16).toBe('llama3270b');
  });

  it('date stamps: Model X 0324 collapses to same slug as Model X', () => {
    const base = _normalizeModelNameForTest('Model X');
    const dated = _normalizeModelNameForTest('Model X 0324');
    expect(dated).toBe(base);
    expect(dated).toBe('modelx');
  });

  it('combined suffixes: Llama 3.2 70B Instruct FP16 0324 strips instruct, fp16, and datestamp', () => {
    const result = _normalizeModelNameForTest('Llama 3.2 70B Instruct FP16 0324');
    expect(result).toBe('llama3270b');
  });

  it('date stamps: DeepSeek-V3-0324 collapses to same slug as DeepSeek-V3', () => {
    const base  = _normalizeModelNameForTest('DeepSeek-V3');
    const dated = _normalizeModelNameForTest('DeepSeek-V3-0324');
    expect(dated).toBe(base);
    expect(dated).toBe('deepseekv3');
  });
});

// ---------------------------------------------------------------------------
// applySyntheticCanonicalModels — slug-based merging in broad families
// ---------------------------------------------------------------------------

/**
 * Helpers to build minimal CatalogModel fixtures.
 * envVars: [] means no API key required — backends always pass the key filter.
 */
function makeCatalogModel(
  id: string,
  name: string,
  family: string,
  providerId: string,
): CatalogModel {
  return {
    id,
    name,
    family,
    provider: providerId,
    providerId,
    providerEnvVars: [],          // no key required — always passes filter
    pricing: { input: 0, output: 0 },
    tier: 'free' as const,
  };
}

/**
 * Build the minimum number of models to exceed MAX_FAMILY_UNIQUE_NAMES (20),
 * triggering broad-family sub-grouping by slug. Returns 21 uniquely-named
 * filler models plus any extras passed in.
 *
 * All models share the same family and alternate between two providers so
 * every resulting canonical group has 2+ distinct providers.
 */
function buildBroadFamily(
  family: string,
  extras: CatalogModel[],
): CatalogModel[] {
  const providers = ['provider-a', 'provider-b'];
  // 21 fillers — each gets a unique name so they don't accidentally
  // collapse with the extras under test.
  const fillers: CatalogModel[] = Array.from({ length: 21 }, (_, i) => {
    const pid = providers[i % 2];
    return makeCatalogModel(`filler-${i}`, `Filler Model ${i}`, family, pid);
  });
  return [...fillers, ...extras];
}

// Capture whatever setSyntheticCanonicalModels receives.
let capturedCanonical: import('../../providers/synthetic.ts').CanonicalModel[] = [];

beforeEach(() => {
  capturedCanonical = [];
  _setSyntheticCanonicalSinkForTest((models) => {
    capturedCanonical = models;
  });
});

afterEach(() => {
  _setSyntheticCanonicalSinkForTest(null);
});

describe('applySyntheticCanonicalModels — slug-based merging in broad families', () => {
  it('merges models whose names differ only in punctuation/spacing into one canonical group', async () => {
    const family = 'gpt';
    // These three models have names that normalise to the same slug ('gpt4o'),
    // but differ in punctuation and spacing. They should end up in ONE canonical group.
    const hyphen    = makeCatalogModel('gpt-4o-openai',    'GPT-4o', family, 'provider-a');
    const space     = makeCatalogModel('gpt-4o-azure',     'GPT 4o', family, 'provider-b');
    const underscore = makeCatalogModel('gpt-4o-microsoft', 'GPT_4o', family, 'provider-c');

    const models = buildBroadFamily(family, [hyphen, space, underscore]);
    await _applySyntheticCanonicalModelsForTest(models);

    // The three variants should share a single canonical ID ('gpt4o').
    const gpt4oEntries = capturedCanonical.filter(c => c.id === 'gpt4o');
    expect(gpt4oEntries).toHaveLength(1);

    // All three backends should be present under that canonical group.
    const backends = gpt4oEntries[0].backends;
    const backendModelIds = backends.map(b => b.modelId);
    expect(backendModelIds).toContain('gpt-4o-openai');
    expect(backendModelIds).toContain('gpt-4o-azure');
    expect(backendModelIds).toContain('gpt-4o-microsoft');
  });

  it('does NOT merge models with genuinely different slugs into the same group', async () => {
    const family = 'gpt';
    // 'GPT-4o' → 'gpt4o', 'GPT-5' → 'gpt5': these must stay separate.
    // Each slug needs 2+ distinct providers to survive the canonical filter.
    const model4o_a = makeCatalogModel('gpt-4o-a', 'GPT-4o', family, 'provider-a');
    const model4o_b = makeCatalogModel('gpt-4o-b', 'GPT-4o', family, 'provider-b');
    const model5_a  = makeCatalogModel('gpt-5-a',  'GPT-5',  family, 'provider-a');
    const model5_b  = makeCatalogModel('gpt-5-b',  'GPT-5',  family, 'provider-b');

    const models = buildBroadFamily(family, [model4o_a, model4o_b, model5_a, model5_b]);
    await _applySyntheticCanonicalModelsForTest(models);

    const ids = capturedCanonical.map(c => c.id);
    expect(ids).toContain('gpt4o');
    expect(ids).toContain('gpt5');
    // They must be separate entries — not collapsed into one.
    expect(ids.filter(id => id === 'gpt4o')).toHaveLength(1);
    expect(ids.filter(id => id === 'gpt5')).toHaveLength(1);
    // The 'gpt4o' group must NOT contain the gpt-5 model IDs.
    const gpt4oBackendIds = capturedCanonical.find(c => c.id === 'gpt4o')!.backends.map(b => b.modelId);
    expect(gpt4oBackendIds).not.toContain('gpt-5-a');
    expect(gpt4oBackendIds).not.toContain('gpt-5-b');
  });

  it('a single-provider group is excluded (requires 2+ distinct providers)', async () => {
    const family = 'llama';
    // Three models with same slug, same provider — should be filtered out because
    // distinctProviders < 2 after the 21 filler models (which use two providers)
    // are in a different family.
    const only = [
      makeCatalogModel('llama-3-a', 'Llama 3',  family, 'provider-solo'),
      makeCatalogModel('llama-3-b', 'Llama  3', family, 'provider-solo'),
    ];
    // Only two models total in the llama family — stays granular (< 21 unique names)
    // but distinctProviders = 1, so it should NOT appear in canonical output.
    await _applySyntheticCanonicalModelsForTest(only);

    const llamaEntry = capturedCanonical.find(c => c.id === 'llama');
    expect(llamaEntry).toBeUndefined();
  });
});
