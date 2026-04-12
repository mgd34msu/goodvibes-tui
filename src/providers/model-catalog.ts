import type { ModelDefinition, ProviderRegistry } from './registry.ts';
import type { ModelLimitsService } from './model-limits.ts';
import type { MinimalModelDefinition, SyntheticModelInfo } from './model-catalog-synthetic.ts';

export interface CatalogProvider {
  id: string;
  name: string;
  envVars: string[];
  baseUrl: string;
  requiresKey?: boolean;
}

export interface CatalogModelPricing {
  input: number;
  output: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  provider: string;
  providerId: string;
  providerEnvVars: string[];
  pricing: CatalogModelPricing;
  tier: 'free' | 'paid' | 'subscription';
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
}

export interface PricingCatalog {
  fetchedAt: number;
  models: CatalogModel[];
}

export function getCostFromPricingCatalog(
  modelId: string,
  catalog: Pick<PricingCatalog, 'models'>,
  modelLimitsService?: Pick<ModelLimitsService, 'getPricingForModel'>,
  opts: { debug?: boolean } = {},
): CatalogModelPricing {
  if (modelId.endsWith(':free')) {
    return { input: 0, output: 0 };
  }
  const exact = catalog.models.find((model) => model.id === modelId);
  if (exact) {
    if (exact.tier === 'free') return { input: 0, output: 0 };
    return { input: exact.pricing.input, output: exact.pricing.output };
  }
  for (const model of catalog.models) {
    if (modelId.startsWith(model.id) || modelId.includes(model.id)) {
      if (model.tier === 'free') return { input: 0, output: 0 };
      return { input: model.pricing.input, output: model.pricing.output };
    }
  }
  if (catalog.models.length === 0) {
    const slashIdx = modelId.indexOf('/');
    const provider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : '';
    const orPricing = modelLimitsService?.getPricingForModel(modelId, provider) ?? null;
    if (orPricing) {
      return { input: orPricing.prompt * 1_000_000, output: orPricing.completion * 1_000_000 };
    }
  }
  if (opts.debug) {
    console.debug(`[cost-tracker] model not in catalog: ${modelId}`);
  }
  return { input: 0, output: 0 };
}

export function normalizeModelId(modelId: string): string {
  let id = modelId;
  if (id.startsWith('coding-')) id = id.slice('coding-'.length);
  const slashIdx = id.lastIndexOf('/');
  if (slashIdx !== -1) id = id.slice(slashIdx + 1);
  if (id.endsWith(':free')) id = id.slice(0, -':free'.length);
  if (id.endsWith('-free')) id = id.slice(0, -'-free'.length);
  return id;
}

export function hasKeyForProvider(provider: CatalogProvider): boolean {
  if (provider.requiresKey === false || provider.envVars.length === 0) return true;
  return provider.envVars.some((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.length > 0;
  });
}

export interface CatalogModelEntry {
  id: string;
  displayName: string;
  provider: string;
  context: number;
  tier: 'free' | 'paid' | 'subscription';
}

export interface CatalogModelChange {
  model: CatalogModel;
  changes: string[];
}

export interface CatalogDiff {
  added: CatalogModel[];
  removed: CatalogModel[];
  changed: CatalogModelChange[];
}

export interface ModelCatalog {
  getModel(modelId: string): CatalogModelEntry | null;
  findLargerContextModels(
    minContext: number,
    tier?: 'free' | 'paid' | 'subscription',
    limit?: number,
  ): CatalogModelEntry[];
}

type ModelCatalogRegistry = Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'>;

export class RegistryBackedCatalog implements ModelCatalog {
  private entriesCache: CatalogModelEntry[] | null = null;
  private entriesCacheVersion = -1;

  constructor(private readonly registry: ModelCatalogRegistry) {}

  private getEntries(): CatalogModelEntry[] {
    const models = this.registry.listModels();
    if (this.entriesCache !== null && models.length === this.entriesCacheVersion) {
      return this.entriesCache;
    }
    this.entriesCacheVersion = models.length;
    this.entriesCache = models.map((model): CatalogModelEntry => ({
      id: model.id,
      displayName: model.displayName,
      provider: model.provider,
      context: this.registry.getContextWindowForModel(model),
      tier: (model.tier ?? 'paid') as 'free' | 'paid' | 'subscription',
    }));
    return this.entriesCache;
  }

  getModel(modelId: string): CatalogModelEntry | null {
    return this.getEntries().find((entry) => entry.id === modelId) ?? null;
  }

  findLargerContextModels(
    minContext: number,
    tier?: 'free' | 'paid' | 'subscription',
    limit = 3,
  ): CatalogModelEntry[] {
    return this.getEntries()
      .filter((entry) => entry.context > minContext && (tier === undefined || entry.tier === tier))
      .sort((a, b) => b.context - a.context)
      .slice(0, limit);
  }
}

export function createModelCatalog(registry: ModelCatalogRegistry): ModelCatalog {
  return new RegistryBackedCatalog(registry);
}

export function getCatalogModelDefinitionsFrom(models: readonly CatalogModel[]): MinimalModelDefinition[] {
  return models.map((model): MinimalModelDefinition => {
    const providerLower = model.provider.toLowerCase();
    const isFree = model.tier === 'free';
    const isGoogle = providerLower.includes('google') || providerLower.includes('gemini');
    const isAnthropic = providerLower.includes('anthropic');
    const isOpenAI = providerLower.includes('openai');
    const hasReasoning = model.reasoning === true || isAnthropic || isOpenAI || isGoogle;
    return {
      id: model.id,
      provider: model.providerId,
      registryKey: `${model.providerId}:${model.id}`,
      displayName: model.name,
      description: `${model.name} — sourced from model catalog.`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: hasReasoning,
        multimodal: isGoogle || isOpenAI,
      },
      contextWindow: model.contextWindow ?? (isGoogle ? 1_000_000 : isAnthropic ? 200_000 : 128_000),
      selectable: true,
      tier: model.tier === 'subscription' ? 'subscription' : isFree ? 'free' : model.pricing.input >= 3 ? 'premium' : 'standard',
      ...(hasReasoning ? { reasoningEffort: ['instant', 'low', 'medium', 'high'] } : {}),
    };
  });
}

export type { MinimalModelDefinition, SyntheticModelInfo } from './model-catalog-synthetic.ts';
export {
  fetchCatalog,
  getCatalogCachePath,
  getCatalogTmpPath,
  isCatalogCacheStale,
  loadCatalogCache,
  saveCatalogCache,
} from './model-catalog-cache.ts';
export {
  buildSyntheticCanonicalModels,
  getSyntheticBackendModelIds,
  getSyntheticModelDefinitions,
  getSyntheticModelInfo,
  nameToSlug,
  normalizeModelName,
} from './model-catalog-synthetic.ts';
export {
  diffCatalogs,
  filterRelevantChanges,
  formatChangeNotifications,
  notifyCatalogChanges,
} from './model-catalog-notifications.ts';
