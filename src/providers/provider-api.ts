import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery/index';
import { HelperModel, type HelperModelDeps } from '../config/helper-model.ts';
import {
  compositeScore,
  getQualityTier,
  getQualityTierFromScore,
  type BenchmarkEntry,
  type BenchmarkStore,
  type ModelBenchmarks,
  type QualityTier,
} from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { MinimalModelDefinition, SyntheticModelInfo } from './model-catalog.ts';
import type { FavoritesData, FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import type { LLMProvider, ProviderRuntimeMetadata } from './interface.ts';
import type { ModelDefinition } from './registry-types.ts';
import {
  getProviderRuntimeSnapshot,
  getProviderUsageSnapshot,
  listProviderRuntimeSnapshots,
  type ProviderRuntimeSnapshot,
  type ProviderUsageSnapshot,
} from './runtime-snapshot.ts';

export interface ProviderApiModelReference {
  readonly modelId: string;
  readonly providerId: string;
  readonly registryKey: string;
}

export interface ProviderApiFavoriteState {
  readonly pinned: boolean;
  readonly recent: boolean;
  readonly pinnedAt?: string;
  readonly lastUsed?: string;
  readonly useCount?: number;
}

export interface ProviderApiSyntheticRouting {
  readonly backendCount: number;
  readonly keyedBackendCount: number;
  readonly tier: string;
  readonly bestCompositeScore: number | null;
}

export interface ProviderApiModelRouting {
  readonly kind: 'direct' | 'synthetic';
  readonly failoverStrategy: 'none' | 'synthetic-wrapper' | 'same-tier-provider' | 'intra-synthetic';
  readonly alternative?: ProviderApiModelReference;
  readonly synthetic?: ProviderApiSyntheticRouting;
}

export interface ProviderApiCatalogBenchmarkRecord extends ProviderApiModelReference {
  readonly kind: 'catalog';
  readonly available: boolean;
  readonly displayName?: string;
  readonly organization: string;
  readonly sourceName: string;
  readonly benchmarks: ModelBenchmarks;
  readonly compositeScore: number | null;
  readonly qualityTier: QualityTier;
}

export interface ProviderApiSyntheticBenchmarkRecord extends ProviderApiModelReference {
  readonly kind: 'synthetic';
  readonly available: boolean;
  readonly displayName?: string;
  readonly backendCount: number;
  readonly keyedBackendCount: number;
  readonly tier: string;
  readonly compositeScore: number | null;
  readonly qualityTier?: QualityTier;
}

export type ProviderApiBenchmarkRecord =
  | ProviderApiCatalogBenchmarkRecord
  | ProviderApiSyntheticBenchmarkRecord;

export interface ProviderApiModelRecord extends ProviderApiModelReference {
  readonly displayName: string;
  readonly description: string;
  readonly selectable: boolean;
  readonly current: boolean;
  readonly capabilities: ModelDefinition['capabilities'];
  readonly contextWindow: number;
  readonly tier?: ModelDefinition['tier'];
  readonly reasoningEffort?: readonly string[];
  readonly favorite: ProviderApiFavoriteState;
  readonly benchmark?: ProviderApiBenchmarkRecord;
  readonly routing: ProviderApiModelRouting;
}

export interface ProviderApiFavoriteRecord {
  readonly modelId: string;
  readonly available: boolean;
  readonly providerId?: string;
  readonly registryKey?: string;
  readonly displayName?: string;
  readonly pinnedAt?: string;
  readonly lastUsed?: string;
  readonly useCount?: number;
}

export interface ProviderApiFavoritesSnapshot {
  readonly pinned: readonly ProviderApiFavoriteRecord[];
  readonly recent: readonly ProviderApiFavoriteRecord[];
}

export interface ProviderApiModelQuery {
  readonly providerId?: string;
  readonly selectableOnly?: boolean;
  readonly favorites?: 'all' | 'pinned' | 'recent';
}

export interface ProviderApiBenchmarkQuery {
  readonly modelRefs?: readonly string[];
  readonly limit?: number;
}

export interface ProviderApiCatalogRefreshResult {
  readonly modelCount: number;
  readonly providerCount: number;
}

export type ProviderApiRuntimeQuery =
  | { readonly scope: 'all' }
  | { readonly scope: 'provider'; readonly providerId: string }
  | { readonly scope: 'usage'; readonly providerId: string };

export type ProviderApiRuntimeQueryResult =
  | { readonly scope: 'all'; readonly snapshots: readonly ProviderRuntimeSnapshot[] }
  | { readonly scope: 'provider'; readonly snapshot: ProviderRuntimeSnapshot | null }
  | { readonly scope: 'usage'; readonly snapshot: ProviderUsageSnapshot | null };

export interface ProviderApi {
  listProviderIds(): readonly string[];
  getCurrentModel(): Promise<ProviderApiModelRecord>;
  listModels(query?: ProviderApiModelQuery): Promise<readonly ProviderApiModelRecord[]>;
  selectModel(modelRef: string): Promise<ProviderApiModelRecord>;
  registerDiscoveredProviders(servers: readonly DiscoveredServer[]): Promise<void>;
  refreshCatalog(): Promise<ProviderApiCatalogRefreshResult>;
  refreshBenchmarks(): Promise<number>;
  refreshModelLimits(): Promise<number>;
  getFavorites(): Promise<ProviderApiFavoritesSnapshot>;
  pinModel(modelRef: string): Promise<ProviderApiFavoritesSnapshot>;
  unpinModel(modelRef: string): Promise<ProviderApiFavoritesSnapshot>;
  recordModelUsage(modelRef: string): Promise<ProviderApiFavoritesSnapshot>;
  listBenchmarks(query?: ProviderApiBenchmarkQuery): Promise<readonly ProviderApiBenchmarkRecord[]>;
  queryRuntimeMetadata(query: ProviderApiRuntimeQuery): Promise<ProviderApiRuntimeQueryResult>;
  createHelperModel(configManager: HelperModelDeps['configManager']): HelperModel;
}

export interface ProviderApiRegistry {
  describeRuntime(name: string): Promise<ProviderRuntimeMetadata | null>;
  findAlternativeModel(currentModelId: string): ModelDefinition | null;
  getCostFromCatalog(modelId: string): { input: number; output: number };
  getCatalogModelDefinitions(): readonly MinimalModelDefinition[];
  get(name: string): LLMProvider;
  getCurrentModel(): ModelDefinition;
  getContextWindowForModel(modelDef: ModelDefinition): number;
  getForModel(modelId: string, provider?: string): LLMProvider;
  getRegistered(name: string): LLMProvider;
  getSelectableModels(): ModelDefinition[];
  getSyntheticModelInfoFromCatalog(modelId: string): SyntheticModelInfo | null;
  listModels(): ModelDefinition[];
  listProviders(): readonly LLMProvider[];
  registerDiscoveredProviders(servers: DiscoveredServer[]): void;
  refreshCatalog(): Promise<void>;
  refreshModelLimits(): Promise<number>;
  setCurrentModel(modelId: string): void;
}

export interface ProviderApiFavoritesStore extends Pick<FavoritesStore, 'load' | 'pinModel' | 'recordUsage' | 'unpinModel'> {}

export interface ProviderApiBenchmarkStore extends Pick<BenchmarkStore, 'getBenchmarks' | 'refreshBenchmarks'> {}

export interface ProviderApiDependencies {
  readonly providerRegistry: ProviderApiRegistry;
  readonly favoritesStore: ProviderApiFavoritesStore;
  readonly benchmarkStore: ProviderApiBenchmarkStore;
}

function cloneFavoritesData(data: FavoritesData): FavoritesData {
  return {
    pinned: data.pinned.map((entry) => ({ ...entry })),
    history: data.history.map((entry) => ({ ...entry })),
  };
}

function findModelDefinition(
  models: readonly ModelDefinition[],
  modelRef: string,
): ModelDefinition | undefined {
  if (modelRef.includes(':')) {
    return models.find((model) => model.registryKey === modelRef) ?? models.find((model) => model.id === modelRef);
  }
  return models.find((model) => model.id === modelRef);
}

function toModelReference(model: ModelDefinition): ProviderApiModelReference {
  return {
    modelId: model.id,
    providerId: model.provider,
    registryKey: model.registryKey,
  };
}

function buildFavoriteIndexes(data: FavoritesData): {
  readonly pinnedByModelId: ReadonlyMap<string, FavoritesData['pinned'][number]>;
  readonly recentByModelId: ReadonlyMap<string, FavoritesData['history'][number]>;
} {
  return {
    pinnedByModelId: new Map(data.pinned.map((entry) => [entry.modelId, entry])),
    recentByModelId: new Map(data.history.map((entry) => [entry.modelId, entry])),
  };
}

function buildSyntheticBenchmarkRecord(
  model: ModelDefinition,
  syntheticInfo: SyntheticModelInfo,
): ProviderApiSyntheticBenchmarkRecord {
  return {
    ...toModelReference(model),
    kind: 'synthetic',
    available: true,
    displayName: model.displayName,
    backendCount: syntheticInfo.backendCount,
    keyedBackendCount: syntheticInfo.keyedBackendCount,
    tier: syntheticInfo.tier,
    compositeScore: syntheticInfo.bestCompositeScore,
    ...(syntheticInfo.bestCompositeScore != null
      ? { qualityTier: getQualityTierFromScore(syntheticInfo.bestCompositeScore) }
      : {}),
  };
}

function buildCatalogBenchmarkRecord(
  model: ModelDefinition,
  benchmark: BenchmarkEntry,
): ProviderApiCatalogBenchmarkRecord {
  return {
    ...toModelReference(model),
    kind: 'catalog',
    available: true,
    displayName: model.displayName,
    organization: benchmark.organization,
    sourceName: benchmark.name,
    benchmarks: benchmark.benchmarks,
    compositeScore: compositeScore(benchmark.benchmarks),
    qualityTier: getQualityTier(benchmark.benchmarks),
  };
}

function buildModelBenchmark(
  model: ModelDefinition,
  deps: ProviderApiDependencies,
): ProviderApiBenchmarkRecord | undefined {
  if (model.provider === 'synthetic') {
    const syntheticInfo = deps.providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
    return syntheticInfo ? buildSyntheticBenchmarkRecord(model, syntheticInfo) : undefined;
  }

  const benchmark = deps.benchmarkStore.getBenchmarks(model.id)
    ?? deps.benchmarkStore.getBenchmarks(model.displayName);
  return benchmark ? buildCatalogBenchmarkRecord(model, benchmark) : undefined;
}

function buildModelRouting(
  model: ModelDefinition,
  deps: ProviderApiDependencies,
): ProviderApiModelRouting {
  if (model.provider === 'synthetic') {
    const syntheticInfo = deps.providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
    return {
      kind: 'synthetic',
      failoverStrategy: 'intra-synthetic',
      ...(syntheticInfo
        ? {
            synthetic: {
              backendCount: syntheticInfo.backendCount,
              keyedBackendCount: syntheticInfo.keyedBackendCount,
              tier: syntheticInfo.tier,
              bestCompositeScore: syntheticInfo.bestCompositeScore,
            },
          }
        : {}),
    };
  }

  const alternative = deps.providerRegistry.findAlternativeModel(model.registryKey);
  if (!alternative) {
    return {
      kind: 'direct',
      failoverStrategy: 'none',
    };
  }

  return {
    kind: 'direct',
    failoverStrategy: alternative.provider === 'synthetic' ? 'synthetic-wrapper' : 'same-tier-provider',
    alternative: toModelReference(alternative),
  };
}

function buildModelRecord(
  model: ModelDefinition,
  currentModel: ModelDefinition,
  favorites: FavoritesData,
  deps: ProviderApiDependencies,
): ProviderApiModelRecord {
  const indexes = buildFavoriteIndexes(favorites);
  const pinned = indexes.pinnedByModelId.get(model.id);
  const recent = indexes.recentByModelId.get(model.id);

  return {
    ...toModelReference(model),
    displayName: model.displayName,
    description: model.description,
    selectable: model.selectable,
    current: currentModel.registryKey === model.registryKey,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    ...(model.tier ? { tier: model.tier } : {}),
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    favorite: {
      pinned: pinned != null,
      recent: recent != null,
      ...(pinned ? { pinnedAt: pinned.pinnedAt } : {}),
      ...(recent ? { lastUsed: recent.lastUsed, useCount: recent.count } : {}),
    },
    ...(buildModelBenchmark(model, deps) ? { benchmark: buildModelBenchmark(model, deps)! } : {}),
    routing: buildModelRouting(model, deps),
  };
}

function buildFavoriteRecord(
  modelId: string,
  models: readonly ModelDefinition[],
  extras: {
    readonly pinnedAt?: string;
    readonly lastUsed?: string;
    readonly useCount?: number;
  },
): ProviderApiFavoriteRecord {
  const model = findModelDefinition(models, modelId);
  return {
    modelId,
    available: model != null,
    ...(model
      ? {
          providerId: model.provider,
          registryKey: model.registryKey,
          displayName: model.displayName,
        }
      : {}),
    ...extras,
  };
}

async function loadFavoritesSnapshot(
  deps: ProviderApiDependencies,
): Promise<ProviderApiFavoritesSnapshot> {
  const favorites = cloneFavoritesData(await deps.favoritesStore.load());
  const models = deps.providerRegistry.listModels();
  const pinned = favorites.pinned.map((entry) =>
    buildFavoriteRecord(entry.modelId, models, { pinnedAt: entry.pinnedAt }),
  );
  const recent = favorites.history
    .slice()
    .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
    .map((entry) =>
      buildFavoriteRecord(entry.modelId, models, {
        lastUsed: entry.lastUsed,
        useCount: entry.count,
      }),
    );
  return { pinned, recent };
}

function applyModelQuery(
  models: readonly ProviderApiModelRecord[],
  query: ProviderApiModelQuery | undefined,
): readonly ProviderApiModelRecord[] {
  if (!query) return models;

  return models.filter((model) => {
    if (query.providerId && model.providerId !== query.providerId) return false;
    if (query.selectableOnly && !model.selectable) return false;
    if (query.favorites === 'pinned' && !model.favorite.pinned) return false;
    if (query.favorites === 'recent' && !model.favorite.recent) return false;
    return true;
  });
}

function resolveModelOrThrow(
  deps: ProviderApiDependencies,
  modelRef: string,
): ModelDefinition {
  const model = findModelDefinition(deps.providerRegistry.listModels(), modelRef);
  if (!model) {
    throw new Error(`Model '${modelRef}' not found.`);
  }
  return model;
}

async function resolvePinnedModelIdOrThrow(
  deps: ProviderApiDependencies,
  modelRef: string,
): Promise<string> {
  const model = findModelDefinition(deps.providerRegistry.listModels(), modelRef);
  if (model) return model.id;

  const favorites = cloneFavoritesData(await deps.favoritesStore.load());
  const pinned = favorites.pinned.find((entry) => entry.modelId === modelRef);
  if (pinned) return pinned.modelId;

  throw new Error(`Model '${modelRef}' not found.`);
}

async function buildBenchmarkRecords(
  deps: ProviderApiDependencies,
  query?: ProviderApiBenchmarkQuery,
): Promise<readonly ProviderApiBenchmarkRecord[]> {
  const models = deps.providerRegistry.listModels();
  const selectedModels = query?.modelRefs
    ? query.modelRefs
        .map((modelRef) => findModelDefinition(models, modelRef))
        .filter((model): model is ModelDefinition => model != null)
    : models;

  const records = selectedModels
    .map((model) => buildModelBenchmark(model, deps))
    .filter((record): record is ProviderApiBenchmarkRecord => record != null)
    .sort((a, b) => {
      const scoreA = a.compositeScore ?? -1;
      const scoreB = b.compositeScore ?? -1;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.registryKey.localeCompare(b.registryKey);
    });

  return typeof query?.limit === 'number' ? records.slice(0, query.limit) : records;
}

function buildCatalogRefreshResult(deps: ProviderApiDependencies): ProviderApiCatalogRefreshResult {
  const models = deps.providerRegistry.getCatalogModelDefinitions();
  return {
    modelCount: models.length,
    providerCount: new Set(models.map((model) => model.provider)).size,
  };
}

export function createProviderApi(deps: ProviderApiDependencies): ProviderApi {
  return {
    listProviderIds(): readonly string[] {
      return deps.providerRegistry
        .listProviders()
        .map((provider) => provider.name)
        .slice()
        .sort((a, b) => a.localeCompare(b));
    },

    async getCurrentModel(): Promise<ProviderApiModelRecord> {
      const currentModel = deps.providerRegistry.getCurrentModel();
      const favorites = cloneFavoritesData(await deps.favoritesStore.load());
      return buildModelRecord(currentModel, currentModel, favorites, deps);
    },

    async listModels(query?: ProviderApiModelQuery): Promise<readonly ProviderApiModelRecord[]> {
      const currentModel = deps.providerRegistry.getCurrentModel();
      const favorites = cloneFavoritesData(await deps.favoritesStore.load());
      const models = deps.providerRegistry.listModels().map((model) =>
        buildModelRecord(model, currentModel, favorites, deps),
      );
      return applyModelQuery(models, query);
    },

    async selectModel(modelRef: string): Promise<ProviderApiModelRecord> {
      deps.providerRegistry.setCurrentModel(modelRef);
      return await this.getCurrentModel();
    },

    async registerDiscoveredProviders(servers: readonly DiscoveredServer[]): Promise<void> {
      deps.providerRegistry.registerDiscoveredProviders([...servers]);
    },

    async refreshCatalog(): Promise<ProviderApiCatalogRefreshResult> {
      await deps.providerRegistry.refreshCatalog();
      return buildCatalogRefreshResult(deps);
    },

    async refreshBenchmarks(): Promise<number> {
      await deps.benchmarkStore.refreshBenchmarks();
      return (await buildBenchmarkRecords(deps)).length;
    },

    async refreshModelLimits(): Promise<number> {
      return await deps.providerRegistry.refreshModelLimits();
    },

    async getFavorites(): Promise<ProviderApiFavoritesSnapshot> {
      return await loadFavoritesSnapshot(deps);
    },

    async pinModel(modelRef: string): Promise<ProviderApiFavoritesSnapshot> {
      const model = resolveModelOrThrow(deps, modelRef);
      await deps.favoritesStore.pinModel(model.id);
      return await loadFavoritesSnapshot(deps);
    },

    async unpinModel(modelRef: string): Promise<ProviderApiFavoritesSnapshot> {
      const modelId = await resolvePinnedModelIdOrThrow(deps, modelRef);
      await deps.favoritesStore.unpinModel(modelId);
      return await loadFavoritesSnapshot(deps);
    },

    async recordModelUsage(modelRef: string): Promise<ProviderApiFavoritesSnapshot> {
      const model = resolveModelOrThrow(deps, modelRef);
      await deps.favoritesStore.recordUsage(model.id);
      return await loadFavoritesSnapshot(deps);
    },

    async listBenchmarks(query?: ProviderApiBenchmarkQuery): Promise<readonly ProviderApiBenchmarkRecord[]> {
      return await buildBenchmarkRecords(deps, query);
    },

    async queryRuntimeMetadata(query: ProviderApiRuntimeQuery): Promise<ProviderApiRuntimeQueryResult> {
      if (query.scope === 'all') {
        return {
          scope: 'all',
          snapshots: await listProviderRuntimeSnapshots(deps.providerRegistry),
        };
      }
      if (query.scope === 'provider') {
        return {
          scope: 'provider',
          snapshot: await getProviderRuntimeSnapshot(deps.providerRegistry, query.providerId),
        };
      }
      return {
        scope: 'usage',
        snapshot: await getProviderUsageSnapshot(deps.providerRegistry, query.providerId),
      };
    },

    createHelperModel(configManager: HelperModelDeps['configManager']): HelperModel {
      return new HelperModel({
        configManager,
        providerRegistry: deps.providerRegistry,
      });
    },
  };
}

export type { ProviderRuntimeSnapshot, ProviderUsageSnapshot };
