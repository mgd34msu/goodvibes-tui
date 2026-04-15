/**
 * Model picker UI data surface barrel.
 *
 * Re-exports all types and the ModelPickerDataProvider class.
 * Also provides the createModelPickerData() factory for one-shot snapshots.
 */
export type {
  CapabilityFlags,
  ProviderLatencyStats,
  ProviderHealthContext,
  ModelPickerEntry,
  ModelPickerGroup,
  ModelPickerData,
} from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/types';
// ProviderStatus re-exported from types for convenience
export type { ProviderStatus } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/types';

export { ModelPickerDataProvider } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/data-provider';
export type { ModelPickerDataProviderOptions } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/data-provider';

import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { ProviderHealthDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
import type { ModelDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
import type { ModelPickerData } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/types';
import { ModelPickerDataProvider } from '@pellux/goodvibes-sdk/platform/runtime/ui/model-picker/data-provider';

/**
 * Produce a one-shot ModelPickerData snapshot without creating a long-lived provider.
 *
 * Use this when you need a single render pass and do not require change subscriptions.
 * For reactive/subscription-based UIs, prefer ModelPickerDataProvider.
 *
 * @param models - All selectable models from the registry.
 * @param healthState - Current provider health domain state.
 * @param modelState - Current model domain state.
 * @param pinnedIds - Set of pinned/favorited model IDs.
 * @returns Immutable ModelPickerData snapshot.
 */
export function createModelPickerData(
  models: readonly ModelDefinition[],
  healthState: ProviderHealthDomainState,
  modelState: ModelDomainState,
  benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
  providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog' | 'getContextWindowForModel'>,
  pinnedIds: ReadonlySet<string> = new Set(),
): ModelPickerData {
  // Delegate to the data provider for consistent derivation logic,
  // then dispose immediately since no subscriptions are needed.
  const dp = new ModelPickerDataProvider(models, healthState, modelState, {
    pinnedIds,
    benchmarkStore,
    providerRegistry,
  });
  const snapshot = dp.getSnapshot();
  dp.dispose();
  return snapshot;
}
