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
} from '@/runtime/index.ts';

export { ProviderHealthDataProvider } from '@/runtime/index.ts';
export { buildFallbackChainData } from '@/runtime/index.ts';

import type { ProviderHealthDomainState } from '@/runtime/index.ts';
import type { ModelDomainState } from '@/runtime/index.ts';
import { ProviderHealthDataProvider } from '@/runtime/index.ts';
import type { ProviderHealthData } from '@/runtime/index.ts';

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
