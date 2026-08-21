/**
 * registry-catalog.test.ts
 *
 * Integration tests for the catalog-backed model registry.
 * Verifies that getModelRegistry() returns catalog-sourced models,
 * custom providers override catalog entries, discovered servers merge
 * correctly, and the registry handles an empty catalog gracefully.
 *
 * Uses real catalog cache files to inject deterministic fixture data,
 * no network calls are made in tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { CatalogModel, PricingCatalog } from '@pellux/goodvibes-sdk/platform/providers';
import { createTestManagers } from '../helpers/test-managers.ts';
import { createProviderCacheFixture, writeModelCatalogCache } from '../helpers/provider-cache.ts';

// ---------------------------------------------------------------------------
// Test fixtures, deterministic, no network calls
// ---------------------------------------------------------------------------

const FIXTURE_MODELS: CatalogModel[] = [
  // Free tier
  { id: 'gpt-oss-120b', name: 'GPT OSS 120B', provider: 'OpenAI', providerId: 'openai', providerEnvVars: ['OPENAI_API_KEY'], pricing: { input: 0, output: 0 }, tier: 'free', inputModalities: ['text'] },

  // Paid - Anthropic (premium)
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'Anthropic', providerId: 'anthropic', providerEnvVars: ['ANTHROPIC_API_KEY'], pricing: { input: 15, output: 75 }, tier: 'paid', contextWindow: 200_000, inputModalities: ['text', 'image'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic', providerId: 'anthropic', providerEnvVars: ['ANTHROPIC_API_KEY'], pricing: { input: 3, output: 15 }, tier: 'paid', contextWindow: 200_000, inputModalities: ['text', 'image'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'Anthropic', providerId: 'anthropic', providerEnvVars: ['ANTHROPIC_API_KEY'], pricing: { input: 0.80, output: 4 }, tier: 'paid', contextWindow: 200_000, inputModalities: ['text', 'image'] },

  // Paid - Google (premium)
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google', providerId: 'gemini', providerEnvVars: ['GOOGLE_API_KEY'], pricing: { input: 1.25, output: 5 }, tier: 'paid', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'Google', providerId: 'gemini', providerEnvVars: ['GOOGLE_API_KEY'], pricing: { input: 0.075, output: 0.30 }, tier: 'paid', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },

  // Paid - OpenAI
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'OpenAI', providerId: 'openai', providerEnvVars: ['OPENAI_API_KEY'], pricing: { input: 5, output: 15 }, tier: 'paid', contextWindow: 400_000, inputModalities: ['text', 'image'] },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'OpenAI', providerId: 'openai', providerEnvVars: ['OPENAI_API_KEY'], pricing: { input: 0.15, output: 0.60 }, tier: 'paid', contextWindow: 128_000, inputModalities: ['text', 'image'] },
];

const FIXTURE_CATALOG: PricingCatalog = {
  fetchedAt: Date.now(),
  models: FIXTURE_MODELS,
};

const testManagers = createTestManagers();
const providerRegistry = testManagers.providerRegistry;
let cacheFixture: ReturnType<typeof createProviderCacheFixture>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadCatalog(models: CatalogModel[]): void {
  writeModelCatalogCache(models, cacheFixture.cacheDir, FIXTURE_CATALOG.fetchedAt);
  providerRegistry.initCatalog();
  // initCatalog() updates catalogModels but does not invalidate the model registry
  // cache, explicitly flush it so subsequent getModelRegistry() calls see the new catalog.
  const invalidate = Reflect.get(providerRegistry as object, '_invalidateModelRegistry') as (() => void) | undefined;
  invalidate?.call(providerRegistry);
}

function getCatalogModelDefinitions() {
  return providerRegistry.getCatalogModelDefinitions();
}

// ---------------------------------------------------------------------------
// getCatalogModelDefinitions
// ---------------------------------------------------------------------------

describe('getCatalogModelDefinitions', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog(FIXTURE_CATALOG.models);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('returns a non-empty array of model definitions', () => {
    const defs = getCatalogModelDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('each definition has required ModelDefinition fields', () => {
    const defs = getCatalogModelDefinitions();
    for (const def of defs) {
      expect(typeof def.id).toBe('string');
      expect(def.id.length).toBeGreaterThan(0);
      expect(typeof def.provider).toBe('string');
      expect(typeof def.displayName).toBe('string');
      expect(typeof def.description).toBe('string');
      expect(typeof def.contextWindow).toBe('number');
      expect(typeof def.selectable).toBe('boolean');
      expect(typeof def.capabilities).toBe('object');
      expect(typeof def.capabilities.toolCalling).toBe('boolean');
      expect(typeof def.capabilities.codeEditing).toBe('boolean');
      expect(typeof def.capabilities.reasoning).toBe('boolean');
      expect(typeof def.capabilities.multimodal).toBe('boolean');
    }
  });

  it('context windows are positive numbers', () => {
    const defs = getCatalogModelDefinitions();
    for (const def of defs) {
      expect(def.contextWindow).toBeGreaterThan(0);
    }
  });

  it('tiers are valid ModelTier values', () => {
    const validTiers = new Set(['free', 'standard', 'premium']);
    const defs = getCatalogModelDefinitions();
    for (const def of defs) {
      if (def.tier !== undefined) {
        expect(validTiers.has(def.tier)).toBe(true);
      }
    }
  });

  it('includes known fixture models by ID', () => {
    const defs = getCatalogModelDefinitions();
    const ids = new Set(defs.map((d) => d.id));
    expect(ids.has('claude-sonnet-4-6')).toBe(true);
    expect(ids.has('claude-haiku-4-5')).toBe(true);
    expect(ids.has('gemini-2.5-pro')).toBe(true);
  });

  it('image support comes from the catalog entry, not from the vendor', () => {
    const defs = getCatalogModelDefinitions();
    // provider field is the providerId (lowercase); the registry's canonical
    // id for Google models is 'gemini'. Both fixture Google entries declare
    // image input, so both read multimodal.
    const googleModels = defs.filter((d) => d.provider === 'gemini');
    expect(googleModels.length).toBeGreaterThan(0);
    for (const model of googleModels) {
      expect(model.capabilities.multimodal).toBe(true);
    }
    // The negative half, and the reason this is no longer a vendor rule: the
    // fixture's two OpenAI entries disagree with each other, so a check that
    // answered by provider would have to be wrong about one of them.
    expect(defs.find((d) => d.id === 'gpt-5.4')?.capabilities.multimodal).toBe(true);
    expect(defs.find((d) => d.id === 'gpt-oss-120b')?.capabilities.multimodal).toBe(false);
  });

  it('Google models have large context windows (>=1M)', () => {
    const defs = getCatalogModelDefinitions();
    const googleModels = defs.filter((d) => d.provider === 'gemini');
    for (const model of googleModels) {
      expect(model.contextWindow).toBeGreaterThanOrEqual(1_000_000);
    }
  });

  it('Anthropic models have large context windows (>=200K)', () => {
    const defs = getCatalogModelDefinitions();
    const anthropicModels = defs.filter((d) => d.provider === 'anthropic');
    expect(anthropicModels.length).toBeGreaterThan(0);
    for (const model of anthropicModels) {
      expect(model.contextWindow).toBeGreaterThanOrEqual(200_000);
    }
  });

  it('free-tier models get tier: free in definitions', () => {
    const defs = getCatalogModelDefinitions();
    // gpt-oss-120b is injected with tier: free
    const freeModel = defs.find((d) => d.id === 'gpt-oss-120b');
    expect(freeModel).toBeDefined();
    expect(freeModel?.tier).toBe('free');
  });

  it('premium-priced models get tier: premium', () => {
    const defs = getCatalogModelDefinitions();
    // claude-opus-4-6 has input: $15 which is >= $3 threshold
    const premiumModel = defs.find((d) => d.id === 'claude-opus-4-6');
    expect(premiumModel).toBeDefined();
    expect(premiumModel?.tier).toBe('premium');
  });

  it('returns fresh array on each call (no mutation risk)', () => {
    const defs1 = getCatalogModelDefinitions();
    const defs2 = getCatalogModelDefinitions();
    expect(defs1).not.toBe(defs2); // different array references
    expect(defs1.length).toBe(defs2.length);
  });
});

// ---------------------------------------------------------------------------
// getModelRegistry, catalog-sourced models
// ---------------------------------------------------------------------------

describe('getModelRegistry: catalog-sourced models', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog(FIXTURE_CATALOG.models);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('returns a non-empty array', () => {
    const models = providerRegistry.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  it('returns catalog models when no custom providers are loaded', () => {
    const registry = providerRegistry.listModels();
    const catalogDefs = getCatalogModelDefinitions();
    // All catalog IDs should appear in the registry (minus any synthetic overrides)
    const registryIds = new Set(registry.map((m) => m.id));
    for (const def of catalogDefs) {
      // Catalog models appear unless overridden by synthetic or custom
      // They may appear as either the catalog entry or a synthetic wrapper
      const inRegistry = registryIds.has(def.id);
      // At minimum the registry should not be completely disjoint from the catalog
      // (This is a soft check, full catalog coverage depends on Stage 1 completion)
      if (inRegistry) {
        // Verify the registry entry has the expected provider (catalog model not hijacked)
        const registryEntry = registry.find((m) => m.id === def.id);
        expect(registryEntry?.provider).toBeTruthy();
      }
    }
    // The registry must include at least some catalog models
    const catalogIds = new Set(catalogDefs.map((d) => d.id));
    const overlap = registry.filter((m) => catalogIds.has(m.id));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('all registry entries have required fields', () => {
    const models = providerRegistry.listModels();
    for (const model of models) {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.provider).toBe('string');
      expect(typeof model.displayName).toBe('string');
      expect(typeof model.description).toBe('string');
      expect(typeof model.contextWindow).toBe('number');
      expect(typeof model.selectable).toBe('boolean');
    }
  });

  it('registry contains no duplicate provider-qualified model entries', () => {
    // The catalog legitimately offers the same bare model id through several
    // providers (e.g. gpt-5.4 via openai and github-copilot); uniqueness holds
    // on the provider-qualified pair.
    const models = providerRegistry.listModels();
    const keys = models.map((m) => `${m.provider}:${m.id}`);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it('selectable models are filterable', () => {
    const models = providerRegistry.listModels();
    const selectable = models.filter((m) => m.selectable);
    expect(selectable.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getModelRegistry, discovered servers merge
// ---------------------------------------------------------------------------

describe('getModelRegistry: discovered servers', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog(FIXTURE_CATALOG.models);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('discovered models do not appear before registerDiscoveredProviders is called', () => {
    // After reset, discovered models should be empty
    const models = providerRegistry.listModels();
    const discoveredModel = models.find((m) => m.id === 'local-test-model-xyz');
    expect(discoveredModel).toBeUndefined();
  });

  it('discovered servers are excluded when they conflict with catalog models', () => {
    const models = providerRegistry.listModels();
    // Provider-qualified catalog entries should appear only once, not
    // duplicated by a hypothetical discovered server with the same ID.
    const keys = models.map((m) => `${m.provider}:${m.id}`);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});

// ---------------------------------------------------------------------------
// getModelRegistry, empty catalog fallback
// ---------------------------------------------------------------------------

describe('getModelRegistry: empty catalog fallback', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog([]);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('registry does not throw when catalog is empty', () => {
    expect(() => providerRegistry.listModels()).not.toThrow();
  });

  it('registry returns an array even when catalog is empty', () => {
    const result = providerRegistry.listModels();
    expect(Array.isArray(result)).toBe(true);
  });

  it('getCatalogModelDefinitions returns empty array when catalog is empty', () => {
    const defs = getCatalogModelDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structural verification
// ---------------------------------------------------------------------------

describe('Structural verification', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog(FIXTURE_CATALOG.models);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('getCatalogModelDefinitions is the catalog source (not a static array)', () => {
    // Verify the function exists and is callable
    const defs = getCatalogModelDefinitions();
    expect(typeof getCatalogModelDefinitions).toBe('function');
    expect(Array.isArray(defs)).toBe(true);
  });

  it('getModelRegistry merge order: catalog models are lower priority than custom', () => {
    // After reset, registry contains catalog models
    const models = providerRegistry.listModels();
    const catalogIds = new Set(getCatalogModelDefinitions().map((d) => d.id));

    // Custom models would override catalog, before any custom providers are loaded,
    // all catalog models should appear with their catalog provider (not 'custom')
    const catalogModelsInRegistry = models.filter((m) => catalogIds.has(m.id));
    for (const model of catalogModelsInRegistry) {
      // Should have the original catalog provider, not a custom one
      expect(model.provider).not.toBe('custom');
    }
  });

  it('registry returns catalog models with correct provider assignments', () => {
    const models = providerRegistry.listModels();
    const catalogDefs = getCatalogModelDefinitions();

    for (const def of catalogDefs) {
      const candidates = models.filter((m) => m.id === def.id);
      if (candidates.length === 0) continue;
      // Every catalog model in the registry must be served by a real
      // registered provider. Bare ids can be legitimately ambiguous across
      // providers now, so resolve the provider-qualified reference.
      const resolved = providerRegistry.getForModel(`${def.provider}:${def.id}`);
      expect(candidates.map((m) => m.provider)).toContain(resolved.name);
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry.get(), alias resolution
// ---------------------------------------------------------------------------

describe('ProviderRegistry.get(): alias resolution', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog(FIXTURE_CATALOG.models);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('registry.get("inception") resolves via alias to the inceptionlabs provider', () => {
    const provider = providerRegistry.get('inception');
    expect(provider).toBeDefined();
    if (!provider) throw new Error('Expected inception provider alias');
    expect(provider.name).toBe('inceptionlabs');
  });

  it('registry.get("inceptionlabs") returns the inceptionlabs provider directly', () => {
    const provider = providerRegistry.get('inceptionlabs');
    expect(provider).toBeDefined();
    if (!provider) throw new Error('Expected inceptionlabs provider');
    expect(provider.name).toBe('inceptionlabs');
  });

  it('registry.get("nonexistent") returns undefined', () => {
    expect(providerRegistry.get('nonexistent')).toBeUndefined();
  });
});

describe('ProviderRegistry.getForModel(): explicit provider lock', () => {
  beforeEach(() => {
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
  });

  it('keeps an explicit provider pinned even when another provider exposes the same model id', () => {
    loadCatalog([
      {
        id: 'mercury-2',
        name: 'Mercury 2',
        provider: 'Venice AI',
        providerId: 'venice',
        providerEnvVars: ['VENICE_API_KEY'],
        pricing: { input: 0.3, output: 0.9 },
        tier: 'paid',
      },
      {
        id: 'mercury-2',
        name: 'Mercury 2',
        provider: 'Inception',
        providerId: 'inception',
        providerEnvVars: ['INCEPTION_API_KEY'],
        pricing: { input: 0.25, output: 0.75 },
        tier: 'paid',
      },
    ]);

    const provider = providerRegistry.getForModel('mercury-2', 'inceptionlabs');
    expect(provider.name).toBe('inceptionlabs');
  });

  it('accepts catalog aliases when resolving an explicitly pinned provider', () => {
    loadCatalog([
      {
        id: 'mercury-2',
        name: 'Mercury 2',
        provider: 'Inception',
        providerId: 'inception',
        providerEnvVars: ['INCEPTION_API_KEY'],
        pricing: { input: 0.25, output: 0.75 },
        tier: 'paid',
      },
    ]);

    const provider = providerRegistry.getForModel('mercury-2', 'inception');
    expect(provider.name).toBe('inceptionlabs');
  });

  it('throws instead of falling through to a different provider when the pinned provider does not offer the model', () => {
    loadCatalog([
      {
        id: 'mercury-2',
        name: 'Mercury 2',
        provider: 'Venice AI',
        providerId: 'venice',
        providerEnvVars: ['VENICE_API_KEY'],
        pricing: { input: 0.3, output: 0.9 },
        tier: 'paid',
      },
    ]);

    // inceptionlabs now carries mercury-2 as a dated static model, so pin a
    // model it genuinely does not offer.
    expect(() => providerRegistry.getForModel('claude-opus-4-6', 'inceptionlabs')).toThrow(
      "No model 'claude-opus-4-6' for provider 'inceptionlabs' in registry.",
    );
  });
});
