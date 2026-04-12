import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  normalizeModelId,
  hasKeyForProvider,
  getCostFromPricingCatalog,
  createModelCatalog,
  getCatalogModelDefinitionsFrom,
} from '../../providers/model-catalog.ts';
import {
  buildSyntheticCanonicalModels,
  nameToSlug,
  normalizeModelName,
} from '../../providers/model-catalog-synthetic.ts';
import type {
  CatalogProvider,
  PricingCatalog,
  CatalogModel,
} from '../../providers/model-catalog.ts';
import type { ModelDefinition, ProviderRegistry } from '../../providers/registry.ts';

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

const COST_FIXTURE: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', providerId: 'anthropic', providerEnvVars: ['ANTHROPIC_API_KEY'], pricing: { input: 3, output: 15 }, tier: 'paid' },
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'OpenAI', providerId: 'openai', providerEnvVars: ['OPENAI_API_KEY'], pricing: { input: 0, output: 0 }, tier: 'free' },
  ],
};

describe('getCostFromPricingCatalog', () => {
  it('returns zero cost for :free suffix models', () => {
    expect(getCostFromPricingCatalog('openai/gpt-4o:free', COST_FIXTURE)).toEqual({ input: 0, output: 0 });
  });
  it('returns correct pricing for exact-match paid model', () => {
    const cost = getCostFromPricingCatalog('claude-sonnet-4-6', COST_FIXTURE);
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });
  it('returns zero cost for free-tier models in catalog', () => {
    expect(getCostFromPricingCatalog('gpt-oss-120b', COST_FIXTURE)).toEqual({ input: 0, output: 0 });
  });
  it('returns zero cost for unknown models (fallback)', () => {
    expect(getCostFromPricingCatalog('unknown-model-xyz-9999', COST_FIXTURE)).toEqual({ input: 0, output: 0 });
  });
  it('handles prefix/substring match for versioned model IDs', () => {
    const cost = getCostFromPricingCatalog('claude-sonnet-4-6-20250101', COST_FIXTURE);
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });
  it('respects an explicit catalog rewrite', () => {
    const customCatalog: PricingCatalog = {
      fetchedAt: Date.now(),
      models: [{ id: 'test-model', name: 'Test Model', provider: 'test', providerId: 'test', providerEnvVars: [], pricing: { input: 42, output: 84 }, tier: 'paid' }],
    };
    const cost = getCostFromPricingCatalog('test-model', customCatalog);
    expect(cost.input).toBe(42);
    expect(cost.output).toBe(84);
  });

  it('falls back to zero after rewriting the catalog with no models', () => {
    const customCatalog: PricingCatalog = {
      fetchedAt: Date.now(),
      models: [{ id: 'test-model', name: 'Test Model', provider: 'test', providerId: 'test', providerEnvVars: [], pricing: { input: 99, output: 99 }, tier: 'paid' }],
    };
    expect(getCostFromPricingCatalog('test-model', customCatalog).input).toBe(99);
    expect(getCostFromPricingCatalog('test-model', { models: [] })).toEqual({ input: 0, output: 0 });
  });
});

describe('getCatalogModelDefinitionsFrom', () => {
  const fixture: CatalogModel[] = [
    {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      family: 'gpt-5',
      provider: 'OpenAI',
      providerId: 'openai',
      providerEnvVars: ['OPENAI_API_KEY'],
      pricing: { input: 5, output: 15 },
      tier: 'paid',
      contextWindow: 400_000,
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      family: 'claude',
      provider: 'Anthropic',
      providerId: 'anthropic',
      providerEnvVars: ['ANTHROPIC_API_KEY'],
      pricing: { input: 3, output: 15 },
      tier: 'paid',
      contextWindow: 200_000,
      reasoning: true,
    },
    {
      id: 'gpt-oss-120b',
      name: 'GPT OSS 120B',
      family: 'gpt-oss',
      provider: 'OpenAI',
      providerId: 'openai',
      providerEnvVars: ['OPENAI_API_KEY'],
      pricing: { input: 0, output: 0 },
      tier: 'free',
      contextWindow: 128_000,
    },
  ];

  it('maps catalog models into selectable model definitions', () => {
    const defs = getCatalogModelDefinitionsFrom(fixture);
    expect(defs).toHaveLength(3);
    expect(defs[0]?.registryKey).toBe('openai:gpt-5.4');
    expect(defs[0]?.provider).toBe('openai');
    expect(defs[0]?.selectable).toBe(true);
  });

  it('marks OpenAI models as multimodal', () => {
    const defs = getCatalogModelDefinitionsFrom(fixture);
    const openaiModels = defs.filter((def) => def.provider === 'openai');
    expect(openaiModels.length).toBeGreaterThan(0);
    for (const model of openaiModels) {
      expect(model.capabilities.multimodal).toBe(true);
    }
  });

  it('marks reasoning models and supplies effort levels', () => {
    const defs = getCatalogModelDefinitionsFrom(fixture);
    const reasoningModel = defs.find((def) => def.id === 'claude-sonnet-4-6');
    expect(reasoningModel?.capabilities.reasoning).toBe(true);
    expect(reasoningModel?.reasoningEffort).toEqual(['instant', 'low', 'medium', 'high']);
  });

  it('uses free and premium tier mapping from pricing', () => {
    const defs = getCatalogModelDefinitionsFrom(fixture);
    expect(defs.find((def) => def.id === 'gpt-oss-120b')?.tier).toBe('free');
    expect(defs.find((def) => def.id === 'claude-sonnet-4-6')?.tier).toBe('premium');
  });

  it('returns fresh arrays on each call', () => {
    const defs1 = getCatalogModelDefinitionsFrom(fixture);
    const defs2 = getCatalogModelDefinitionsFrom(fixture);
    expect(defs1).not.toBe(defs2);
    expect(defs1.length).toBe(defs2.length);
  });
});

function makeRegistry(models: ModelDefinition[]): Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'> {
  return {
    listModels: () => models,
    getContextWindowForModel: (model) => model.contextWindow,
  };
}

const MODEL_CATALOG_FIXTURE: ModelDefinition[] = [
  {
    id: 'small-model',
    provider: 'openai',
    registryKey: 'openai:small-model',
    displayName: 'Small Model',
    description: 'Small test model',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 32_768,
    selectable: true,
  },
  {
    id: 'medium-model',
    provider: 'anthropic',
    registryKey: 'anthropic:medium-model',
    displayName: 'Medium Model',
    description: 'Medium test model',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
  },
  {
    id: 'large-model',
    provider: 'gemini',
    registryKey: 'gemini:large-model',
    displayName: 'Large Model',
    description: 'Large test model',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 1_000_000,
    selectable: true,
  },
];

describe('createModelCatalog', () => {
  it('returns a catalog object with getModel and findLargerContextModels', () => {
    const catalog = createModelCatalog(makeRegistry(MODEL_CATALOG_FIXTURE));
    expect(typeof catalog.getModel).toBe('function');
    expect(typeof catalog.findLargerContextModels).toBe('function');
  });
  it('getModel returns null for unknown model IDs', () => {
    const catalog = createModelCatalog(makeRegistry(MODEL_CATALOG_FIXTURE));
    expect(catalog.getModel('nonexistent-model-xyz')).toBeNull();
  });
  it('findLargerContextModels returns array', () => {
    const catalog = createModelCatalog(makeRegistry(MODEL_CATALOG_FIXTURE));
    expect(Array.isArray(catalog.findLargerContextModels(0))).toBe(true);
  });
  it('findLargerContextModels respects limit parameter', () => {
    const catalog = createModelCatalog(makeRegistry(MODEL_CATALOG_FIXTURE));
    expect(catalog.findLargerContextModels(0, undefined, 2).length).toBeLessThanOrEqual(2);
  });
  it('findLargerContextModels returns results sorted by context descending', () => {
    const catalog = createModelCatalog(makeRegistry(MODEL_CATALOG_FIXTURE));
    const results = catalog.findLargerContextModels(0, undefined, 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].context).toBeGreaterThanOrEqual(results[i].context);
    }
  });
  it('findLargerContextModels filters by minContext', () => {
    const catalog = createModelCatalog(makeRegistry(MODEL_CATALOG_FIXTURE));
    const results = catalog.findLargerContextModels(100_000, undefined, 20);
    for (const r of results) {
      expect(r.context).toBeGreaterThan(100_000);
    }
  });
});

// ---------------------------------------------------------------------------
// nameToSlug (slug normalisation)
// ---------------------------------------------------------------------------

describe('nameToSlug', () => {
  it('lowercases a plain name', () => {
    expect(nameToSlug('GPT')).toBe('gpt');
  });
  it('strips spaces entirely', () => {
    expect(nameToSlug('GPT 4o')).toBe('gpt4o');
  });
  it('strips dashes entirely', () => {
    expect(nameToSlug('GPT-4o')).toBe('gpt4o');
  });
  it('strips underscores entirely', () => {
    expect(nameToSlug('GPT_4o')).toBe('gpt4o');
  });
  it('GPT-4o, GPT 4o, and GPT_4o all produce the same slug', () => {
    const a = nameToSlug('GPT-4o');
    const b = nameToSlug('GPT 4o');
    const c = nameToSlug('GPT_4o');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('gpt4o');
  });
  it('strips all non-alphanumeric chars including consecutive runs', () => {
    expect(nameToSlug('hello  --  world')).toBe('helloworld');
  });
  it('strips leading and trailing non-alphanumeric chars', () => {
    expect(nameToSlug('-leading')).toBe('leading');
    expect(nameToSlug('trailing-')).toBe('trailing');
  });
  it('handles names with only non-alphanumeric chars', () => {
    expect(nameToSlug('---')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// normalizeModelName — preserved vs stripped identifiers
// ---------------------------------------------------------------------------

describe('normalizeModelName', () => {
  it('mini vs pro: GPT-5.4 Mini and GPT-5.4 Pro yield different slugs', () => {
    const mini = normalizeModelName('GPT-5.4 Mini');
    const pro = normalizeModelName('GPT-5.4 Pro');
    expect(mini).not.toBe(pro);
    expect(mini).toBe('gpt54mini');
    expect(pro).toBe('gpt54pro');
  });

  it('version numbers: DeepSeek V3 and DeepSeek V3.1 yield different slugs', () => {
    const v3 = normalizeModelName('DeepSeek V3');
    const v31 = normalizeModelName('DeepSeek V3.1');
    expect(v3).not.toBe(v31);
    expect(v3).toBe('deepseekv3');
    expect(v31).toBe('deepseekv31');
  });

  it('size indicators: Llama 3.2 1B and Llama 3.2 70B yield different slugs', () => {
    const b1 = normalizeModelName('Llama 3.2 1B');
    const b70 = normalizeModelName('Llama 3.2 70B');
    expect(b1).not.toBe(b70);
    expect(b1).toBe('llama321b');
    expect(b70).toBe('llama3270b');
  });

  it('thinking vs base: Kimi K2 Thinking and Kimi K2 yield different slugs', () => {
    const thinking = normalizeModelName('Kimi K2 Thinking');
    const base = normalizeModelName('Kimi K2');
    expect(thinking).not.toBe(base);
    expect(thinking).toBe('kimik2thinking');
    expect(base).toBe('kimik2');
  });

  it('size indicators resembling dates are preserved: Model 1024B', () => {
    const slug = normalizeModelName('Model 1024B');
    expect(slug).toBe('model1024b');
  });

  it('instruct variant: Kimi K2 Instruct collapses to same slug as Kimi K2', () => {
    const base = normalizeModelName('Kimi K2');
    const instruct = normalizeModelName('Kimi K2 Instruct');
    expect(instruct).toBe(base);
    expect(instruct).toBe('kimik2');
  });

  it('chat variant: Model X Chat collapses to same slug as Model X', () => {
    const base = normalizeModelName('Model X');
    const chat = normalizeModelName('Model X Chat');
    expect(chat).toBe(base);
    expect(chat).toBe('modelx');
  });

  it('quantization: Llama 3.2 70B FP16 and Llama 3.2 70B GPTQ collapse to the same slug', () => {
    const fp16 = normalizeModelName('Llama 3.2 70B FP16');
    const gptq = normalizeModelName('Llama 3.2 70B GPTQ');
    expect(fp16).toBe(gptq);
    expect(fp16).toBe('llama3270b');
  });

  it('date stamps: Model X 0324 collapses to same slug as Model X', () => {
    const base = normalizeModelName('Model X');
    const dated = normalizeModelName('Model X 0324');
    expect(dated).toBe(base);
    expect(dated).toBe('modelx');
  });

  it('combined suffixes: Llama 3.2 70B Instruct FP16 0324 strips instruct, fp16, and datestamp', () => {
    const result = normalizeModelName('Llama 3.2 70B Instruct FP16 0324');
    expect(result).toBe('llama3270b');
  });

  it('date stamps: DeepSeek-V3-0324 collapses to same slug as DeepSeek-V3', () => {
    const base = normalizeModelName('DeepSeek-V3');
    const dated = normalizeModelName('DeepSeek-V3-0324');
    expect(dated).toBe(base);
    expect(dated).toBe('deepseekv3');
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticCanonicalModels — slug-based merging in broad families
// ---------------------------------------------------------------------------

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
    providerEnvVars: [],
    pricing: { input: 0, output: 0 },
    tier: 'free' as const,
  };
}

function buildBroadFamily(
  family: string,
  extras: CatalogModel[],
): CatalogModel[] {
  const providers = ['provider-a', 'provider-b'];
  const fillers: CatalogModel[] = Array.from({ length: 21 }, (_, i) => {
    const pid = providers[i % 2];
    return makeCatalogModel(`filler-${i}`, `Filler Model ${i}`, family, pid);
  });
  return [...fillers, ...extras];
}

describe('buildSyntheticCanonicalModels — slug-based merging in broad families', () => {
  it('merges models whose names differ only in punctuation/spacing into one canonical group', () => {
    const family = 'gpt';
    const hyphen = makeCatalogModel('gpt-4o-openai', 'GPT-4o', family, 'provider-a');
    const space = makeCatalogModel('gpt-4o-azure', 'GPT 4o', family, 'provider-b');
    const underscore = makeCatalogModel('gpt-4o-microsoft', 'GPT_4o', family, 'provider-c');

    const models = buildBroadFamily(family, [hyphen, space, underscore]);
    const canonical = buildSyntheticCanonicalModels(models);

    const gpt4oEntries = canonical.filter((c) => c.id === 'gpt4o');
    expect(gpt4oEntries).toHaveLength(1);

    const backendModelIds = gpt4oEntries[0]!.backends.map((b) => b.modelId);
    expect(backendModelIds).toContain('gpt-4o-openai');
    expect(backendModelIds).toContain('gpt-4o-azure');
    expect(backendModelIds).toContain('gpt-4o-microsoft');
  });

  it('does NOT merge models with genuinely different slugs into the same group', () => {
    const family = 'gpt';
    const model4oA = makeCatalogModel('gpt-4o-a', 'GPT-4o', family, 'provider-a');
    const model4oB = makeCatalogModel('gpt-4o-b', 'GPT-4o', family, 'provider-b');
    const model5A = makeCatalogModel('gpt-5-a', 'GPT-5', family, 'provider-a');
    const model5B = makeCatalogModel('gpt-5-b', 'GPT-5', family, 'provider-b');

    const models = buildBroadFamily(family, [model4oA, model4oB, model5A, model5B]);
    const canonical = buildSyntheticCanonicalModels(models);

    const ids = canonical.map((c) => c.id);
    expect(ids).toContain('gpt4o');
    expect(ids).toContain('gpt5');
    expect(ids.filter((id) => id === 'gpt4o')).toHaveLength(1);
    expect(ids.filter((id) => id === 'gpt5')).toHaveLength(1);
    const gpt4oBackendIds = canonical.find((c) => c.id === 'gpt4o')!.backends.map((b) => b.modelId);
    expect(gpt4oBackendIds).not.toContain('gpt-5-a');
    expect(gpt4oBackendIds).not.toContain('gpt-5-b');
  });

  it('a single-provider group is excluded (requires 2+ distinct providers)', () => {
    const family = 'llama';
    const only = [
      makeCatalogModel('llama-3-a', 'Llama 3', family, 'provider-solo'),
      makeCatalogModel('llama-3-b', 'Llama  3', family, 'provider-solo'),
    ];

    const canonical = buildSyntheticCanonicalModels(only);
    const llamaEntry = canonical.find((c) => c.id === 'llama');
    expect(llamaEntry).toBeUndefined();
  });
});
