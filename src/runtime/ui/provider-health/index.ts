/**
 * Provider health UI data surface barrel.
 *
 * Re-exports all types and the ProviderHealthDataProvider class.
 * Also provides the createProviderHealthData() factory for one-shot snapshots.
 */
export type {
  ProviderStatus,
  CompositeHealthStatus,
  HealthTimelinePoint,
  HealthTimeline,
  ProviderHealthEntry,
  FallbackChainNode,
  FallbackChainData,
  ProviderHealthData,
} from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/types';

export { ProviderHealthDataProvider } from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/data-provider';
export { buildFallbackChainData } from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/fallback-visualizer';

import type { ProviderHealthDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/provider-health';
import type { ModelDomainState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/model';
import { ProviderHealthDataProvider } from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/data-provider';
import type { ProviderHealthData } from '@pellux/goodvibes-sdk/platform/runtime/ui/provider-health/types';

/**
 * Produce a one-shot ProviderHealthData snapshot without creating a long-lived provider.
 *
 * Use this when you need a single render pass and do not require change subscriptions.
 * For reactive/subscription-based UIs, prefer ProviderHealthDataProvider.
 *
 * @param healthState - Current provider health domain state.
 * @param modelState - Current model domain state.
 * @returns Immutable ProviderHealthData snapshot.
 */
export function createProviderHealthData(
  healthState: ProviderHealthDomainState,
  modelState: ModelDomainState,
): ProviderHealthData {
  // Delegate to the data provider for consistent derivation logic,
  // then dispose immediately since no subscriptions are needed.
  const dp = new ProviderHealthDataProvider(healthState, modelState);
  const snapshot = dp.getSnapshot();
  dp.dispose();
  return snapshot;
}
