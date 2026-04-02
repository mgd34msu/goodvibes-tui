/**
 * Fallback chain visualization data builder.
 *
 * Converts the raw fallback chain from ModelDomainState and current
 * provider health records into a structured FallbackChainData snapshot
 * suitable for UI rendering.
 */
import type { ModelDomainState } from '../../store/domains/model.ts';
import type { ProviderHealthDomainState } from '../../store/domains/provider-health.ts';
import type { FallbackChainData, FallbackChainNode } from './types.ts';

/**
 * Build a FallbackChainData snapshot from the current model and health state.
 *
 * The primary model is always node 0. Each entry in ModelDomainState.fallbackChain
 * becomes a subsequent node. Health status is enriched from the provider health domain.
 *
 * @param modelState - Current model domain state.
 * @param healthState - Current provider health domain state.
 * @returns Immutable FallbackChainData for visualization.
 */
export function buildFallbackChainData(
  modelState: ModelDomainState,
  healthState: ProviderHealthDomainState,
): FallbackChainData {
  const nodes: FallbackChainNode[] = [];

  // Node 0 — primary (active model)
  const primaryRecord = healthState.providers.get(modelState.activeProviderId);
  nodes.push({
    providerId: modelState.activeProviderId,
    modelId: modelState.activeModelId,
    displayName: modelState.displayName,
    position: 0,
    isCurrent: modelState.activeFallbackIndex === -1,
    providerStatus: primaryRecord?.status ?? 'unknown',
    reason: undefined,
  });

  // Nodes 1..N — fallback chain entries
  for (let i = 0; i < modelState.fallbackChain.length; i++) {
    const entry = modelState.fallbackChain[i];
    const record = healthState.providers.get(entry.providerId);
    nodes.push({
      providerId: entry.providerId,
      modelId: entry.modelId,
      displayName: entry.displayName,
      position: i + 1,
      isCurrent: modelState.activeFallbackIndex === i,
      providerStatus: record?.status ?? 'unknown',
      reason: entry.reason,
    });
  }

  const hasUnhealthyNode = nodes.some(
    (n) =>
      n.providerStatus === 'degraded' ||
      n.providerStatus === 'rate_limited' ||
      n.providerStatus === 'unavailable' ||
      n.providerStatus === 'auth_error',
  );

  return {
    nodes,
    activeIndex: modelState.activeFallbackIndex,
    falloverCount: modelState.falloverCount,
    hasUnhealthyNode,
  };
}
