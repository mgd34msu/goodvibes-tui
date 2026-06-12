/**
 * model-picker-items — pure item-building helpers for ModelPickerModal.
 *
 * Converts filtered ModelDefinition/provider arrays into PickerItem lists
 * with group headers, quality-tier badges, pin markers, and configured-via flags.
 * All functions are stateless.
 */

import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import { EFFORT_DESCRIPTIONS, getQualityTier, getQualityTierFromScore } from '@pellux/goodvibes-sdk/platform/providers';
import type { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import {
  POPULAR_PROVIDERS,
  detectFamily,
  tierToCategoryFilter,
} from './model-picker-types.ts';
import type {
  GroupByMode,
  ModelItemsCache,
  PickerItem,
  ProviderItemsCache,
} from './model-picker-types.ts';
import { getSyntheticSubgroup, setKey, mapKey } from './model-picker-filter.ts';

// ---------------------------------------------------------------------------
// getModelGroupKey
// ---------------------------------------------------------------------------

export function getModelGroupKey(
  model: ModelDefinition,
  groupBy: GroupByMode,
  providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>,
  benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
): string {
  switch (groupBy) {
    case 'provider':
      if (model.provider === 'synthetic') {
        return getSyntheticSubgroup(model, providerRegistry) === 'top' ? 'Top Models' : 'All Synthetic';
      }
      return model.provider;
    case 'family':
      return detectFamily(model);
    case 'pricingTier':
      return tierToCategoryFilter(model.tier);
    case 'qualityTier': {
      if (model.provider === 'synthetic') {
        const info = providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
        return info?.bestCompositeScore != null ? getQualityTierFromScore(info.bestCompositeScore) : 'C';
      }
      const b = benchmarkStore.getBenchmarks(model.id) ?? benchmarkStore.getBenchmarks(model.displayName);
      return b ? getQualityTier(b.benchmarks) : 'C';
    }
  }
}

// ---------------------------------------------------------------------------
// toModelItem — single model -> PickerItem
// ---------------------------------------------------------------------------

export function toModelItem(
  model: ModelDefinition,
  isPinned: boolean,
  providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>,
  benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
): PickerItem {
  let qualityTier: string | undefined;
  let detail: string;

  if (model.provider === 'synthetic') {
    const synthInfo = providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
    if (synthInfo?.bestCompositeScore != null) {
      qualityTier = getQualityTierFromScore(synthInfo.bestCompositeScore);
    }
    detail = synthInfo !== null
      ? `${model.provider} [${synthInfo.keyedBackendCount} provider${synthInfo.keyedBackendCount !== 1 ? 's' : ''}]`
      : model.provider;
  } else {
    detail = model.provider;
    const b = benchmarkStore.getBenchmarks(model.id) ?? benchmarkStore.getBenchmarks(model.displayName);
    qualityTier = b ? getQualityTier(b.benchmarks) : undefined;
  }

  const isFree = tierToCategoryFilter(model.tier) === 'free';

  return {
    id: model.id,
    label: model.displayName,
    detail,
    qualityTier,
    isPinned,
    isFree,
  };
}

// ---------------------------------------------------------------------------
// buildModelItems — filtered models -> PickerItem[] with group headers
// ---------------------------------------------------------------------------

export function buildModelItems(
  filtered: ModelDefinition[],
  pinnedIds: ReadonlySet<string>,
  groupBy: GroupByMode,
  providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>,
  benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
  cache: ModelItemsCache | null,
): { result: PickerItem[]; cache: ModelItemsCache } {
  const pinnedIdsKey = setKey(pinnedIds);

  if (
    cache !== null
    && cache.filteredModelsRef === filtered
    && cache.pinnedIdsKey === pinnedIdsKey
    && cache.groupBy === groupBy
  ) {
    return { result: cache.result, cache };
  }

  const pinned = filtered.filter(m => pinnedIds.has(m.id));
  const unpinned = filtered.filter(m => !pinnedIds.has(m.id));

  const items: PickerItem[] = [];

  // Pinned section header (only if pinned models are in the filtered list)
  if (pinned.length > 0) {
    items.push({ id: '__header__pinned', label: 'Favorites', isGroupHeader: true });
    for (const m of pinned) {
      items.push(toModelItem(m, true, providerRegistry, benchmarkStore));
    }
  }

  // Grouped unpinned models
  let lastGroupKey = '';
  for (const m of unpinned) {
    const groupKey = getModelGroupKey(m, groupBy, providerRegistry, benchmarkStore);
    if (groupKey !== lastGroupKey) {
      items.push({ id: `__header__${groupKey}`, label: groupKey, isGroupHeader: true });
      lastGroupKey = groupKey;
    }
    items.push(toModelItem(m, false, providerRegistry, benchmarkStore));
  }

  const newCache: ModelItemsCache = {
    filteredModelsRef: filtered,
    pinnedIdsKey,
    groupBy,
    result: items,
  };

  return { result: items, cache: newCache };
}

// ---------------------------------------------------------------------------
// buildProviderItems — filtered providers -> PickerItem[] with group headers
// ---------------------------------------------------------------------------

export function buildProviderItems(
  filteredProviders: string[],
  configuredProviders: ReadonlySet<string>,
  configuredViaMap: ReadonlyMap<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>,
  cache: ProviderItemsCache | null,
): { result: PickerItem[]; cache: ProviderItemsCache } {
  const configuredProvidersKey = setKey(configuredProviders);
  const configuredViaKey = mapKey(configuredViaMap);

  if (
    cache !== null
    && cache.filteredProvidersRef === filteredProviders
    && cache.configuredProvidersKey === configuredProvidersKey
    && cache.configuredViaKey === configuredViaKey
  ) {
    return { result: cache.result, cache };
  }

  const items: PickerItem[] = [];
  let currentGroup: 'Popular' | 'All Providers' | null = null;

  for (const p of filteredProviders) {
    const group: 'Popular' | 'All Providers' = POPULAR_PROVIDERS.has(p.toLowerCase()) ? 'Popular' : 'All Providers';
    if (group !== currentGroup) {
      items.push({ id: `__header__${group}`, label: group, isGroupHeader: true });
      currentGroup = group;
    }
    items.push({
      id: p,
      label: p,
      isConfigured: configuredProviders.has(p),
      configuredVia: configuredViaMap.get(p),
    });
  }

  const newCache: ProviderItemsCache = {
    filteredProvidersRef: filteredProviders,
    configuredProvidersKey,
    configuredViaKey,
    result: items,
  };

  return { result: items, cache: newCache };
}

// ---------------------------------------------------------------------------
// buildEffortItems — effort levels -> PickerItem[]
// ---------------------------------------------------------------------------

export function buildEffortItems(effortLevels: readonly string[]): PickerItem[] {
  return effortLevels.map(e => ({ id: e, label: e, detail: EFFORT_DESCRIPTIONS[e] ?? '' }));
}
