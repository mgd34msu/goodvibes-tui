/**
 * Health enrichment for model picker entries.
 *
 * Joins ModelDefinition records from the provider registry with health
 * telemetry from ProviderHealthDomainState to produce enriched
 * ModelPickerEntry objects ready for UI consumption.
 */
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { ProviderHealthDomainState, ProviderHealthRecord } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
import type { ModelDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
import { detectFamily, tierToCategoryFilter } from '../../../input/model-picker.ts';
import { getQualityTier, getQualityTierFromScore, compositeScore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type {
  ModelPickerEntry,
  ModelPickerGroup,
  ProviderHealthContext,
  CapabilityFlags,
  ProviderLatencyStats,
} from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/types';

/** Status sort priority (lower = shown first). */
const STATUS_ORDER: Record<string, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  rate_limited: 3,
  auth_error: 4,
  unavailable: 5,
};

/**
 * Derive ProviderHealthContext from a ProviderHealthRecord.
 * Returns a safe default when the record is absent (provider not yet observed).
 */
function buildHealthContext(record: ProviderHealthRecord | undefined): ProviderHealthContext {
  if (!record) {
    return {
      status: 'unknown',
      isConfigured: false,
    };
  }

  let latency: ProviderLatencyStats | undefined;
  if (record.stats.totalCalls > 0) {
    latency = {
      avgMs: record.stats.avgLatencyMs,
      p95Ms: record.stats.maxLatencyMs,
      minMs: record.stats.minLatencyMs,
    };
  }

  return {
    status: record.status,
    latency,
    cacheHitRate: record.cacheMetrics?.hitRate,
    isConfigured: record.isConfigured,
    rateLimitResetAt: record.rateLimitResetAt,
  };
}

/**
 * Derive CapabilityFlags from a ModelDefinition.
 */
function buildCapabilityFlags(model: ModelDefinition): CapabilityFlags {
  return {
    reasoning: model.capabilities?.reasoning ?? false,
    caching: false, // caching capability is provider-level; enriched separately if needed
    toolCalling: model.capabilities?.toolCalling ?? false,
    multimodal: model.capabilities?.multimodal ?? false,
    codeEditing: model.capabilities?.codeEditing ?? false,
  };
}

/**
 * Derive quality tier and benchmark score for a model.
 * Handles synthetic models (catalog-backed composite scores) and standard models.
 */
function buildQualityInfo(
  model: ModelDefinition,
  benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
  providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>,
): { qualityTier?: string; benchmarkScore?: number } {
  if (model.provider === 'synthetic') {
    const info = providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
    if (info?.bestCompositeScore != null) {
      return {
        qualityTier: getQualityTierFromScore(info.bestCompositeScore),
        benchmarkScore: info.bestCompositeScore,
      };
    }
    return {};
  }

  const benchmarks = benchmarkStore.getBenchmarks(model.id) ?? benchmarkStore.getBenchmarks(model.displayName);
  if (!benchmarks) return {};

  return {
    qualityTier: getQualityTier(benchmarks.benchmarks),
    benchmarkScore: compositeScore(benchmarks.benchmarks) ?? undefined,
  };
}

/**
 * Build the set of model IDs in the current fallback chain.
 * Returns a Map from modelId to its position (0 = primary).
 */
function buildFallbackPositionMap(modelState: ModelDomainState): Map<string, number> {
  const map = new Map<string, number>();
  // Position 0 is always the primary active model
  map.set(modelState.activeModelId, 0);
  for (let i = 0; i < modelState.fallbackChain.length; i++) {
    const entry = modelState.fallbackChain[i];
    if (!map.has(entry.modelId)) {
      map.set(entry.modelId, i + 1);
    }
  }
  return map;
}

/**
 * Enrich a flat list of ModelDefinitions with health and state data.
 *
 * @param models - All selectable models from the registry.
 * @param healthState - Current provider health domain state.
 * @param modelState - Current model domain state.
 * @param pinnedIds - Set of pinned/favorited model IDs.
 * @returns Sorted, enriched ModelPickerEntry array.
 */
export function enrichModelEntries(
  models: readonly ModelDefinition[],
  healthState: ProviderHealthDomainState,
  modelState: ModelDomainState,
  pinnedIds: ReadonlySet<string>,
  benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
  providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog' | 'getContextWindowForModel'>,
): ModelPickerEntry[] {
  const fallbackPositions = buildFallbackPositionMap(modelState);

  const entries: ModelPickerEntry[] = models.map((model) => {
    const record = healthState.providers.get(model.provider);
    const health = buildHealthContext(record);
    const { qualityTier, benchmarkScore } = buildQualityInfo(model, benchmarkStore, providerRegistry);
    const isProviderDegraded =
      health.status === 'degraded' || health.status === 'rate_limited';
    const isProviderUnavailable =
      health.status === 'unavailable' || health.status === 'auth_error';

    const fallbackPosition = fallbackPositions.get(model.id);

    // Resolve effective context window and determine display source label.
    const effectiveContextWindow = providerRegistry.getContextWindowForModel(model);
    // Determine source: custom/local providers carry provenance on ModelDefinition;
    // for catalog models, if getContextWindowForModel returned more than the
    // static contextWindow it came from OpenRouter, else it's the registry value.
    let contextWindowSource: ModelPickerEntry['contextWindowSource'];
    if (model.contextWindowProvenance) {
      contextWindowSource = model.contextWindowProvenance;
    } else if (effectiveContextWindow !== model.contextWindow) {
      contextWindowSource = 'openrouter';
    } else {
      contextWindowSource = 'registry';
    }

    return {
      modelId: model.id,
      providerId: model.provider,
      displayName: model.displayName,
      family: detectFamily(model),
      pricingTier: tierToCategoryFilter(model.tier),
      qualityTier,
      benchmarkScore,
      capabilities: buildCapabilityFlags(model),
      health,
      contextWindow: effectiveContextWindow,
      contextWindowSource,
      isPinned: pinnedIds.has(model.id),
      isActive: model.id === modelState.activeModelId,
      isProviderDegraded,
      isProviderUnavailable,
      isInFallbackChain: fallbackPosition !== undefined,
      fallbackPosition,
    };
  });

  // Sort: healthy providers first, then degraded, then unavailable.
  // Within each status bucket: pinned first, then active, then by display name.
  entries.sort((a, b) => {
    const statusDiff =
      (STATUS_ORDER[a.health.status] ?? 1) - (STATUS_ORDER[b.health.status] ?? 1);
    if (statusDiff !== 0) return statusDiff;

    // Pinned before unpinned
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    // Active before inactive
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;

    return a.displayName.localeCompare(b.displayName);
  });

  return entries;
}

/**
 * Group a sorted list of ModelPickerEntry records by their provider ID.
 * Preserves the sort order of entries within each group.
 *
 * @param entries - Pre-sorted enriched entries.
 * @returns Groups ordered by first appearance of each provider in entries.
 */
export function groupEntriesByProvider(entries: readonly ModelPickerEntry[]): ModelPickerGroup[] {
  const groupMap = new Map<string, ModelPickerEntry[]>();
  const groupOrder: string[] = [];

  for (const entry of entries) {
    if (!groupMap.has(entry.providerId)) {
      groupMap.set(entry.providerId, []);
      groupOrder.push(entry.providerId);
    }
    groupMap.get(entry.providerId)!.push(entry);
  }

  return groupOrder.map((providerId) => ({
    label: providerId,
    entries: groupMap.get(providerId)!,
  }));
}
