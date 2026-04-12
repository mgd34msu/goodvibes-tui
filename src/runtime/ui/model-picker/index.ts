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
} from './types.ts';
// ProviderStatus re-exported from types for convenience
export type { ProviderStatus } from './types.ts';

export { ModelPickerDataProvider } from './data-provider.ts';
export type { ModelPickerDataProviderOptions } from './data-provider.ts';

import type { ModelDefinition } from '../../../providers/registry.ts';
import type { ProviderRegistry } from '../../../providers/registry.ts';
import type { BenchmarkStore } from '../../../providers/model-benchmarks.ts';
import type { ProviderHealthDomainState } from '../../store/domains/provider-health.ts';
import type { ModelDomainState } from '../../store/domains/model.ts';
import type { ModelPickerData } from './types.ts';
import { ModelPickerDataProvider } from './data-provider.ts';

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
