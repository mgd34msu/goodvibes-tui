/**
 * fleet-services.ts — the shared, archive-aware fleet registry construction,
 * lifted out of services.ts so the composition root stays under the file-size
 * cap. Mirrors the sibling create*Services helpers (durability, code-index,
 * workstream): a single dependency-injected call that services.ts makes once.
 *
 * Also owns the daemon-side observed foreign-agent source: when
 * observeExternalAgents is on (the standalone daemon), externally-launched
 * coding-agent sessions observed read-only on the host fold in as
 * 'observed-external' rows (visibility + steer; never counted against
 * fleet.maxSize, never stopped). The interactive process leaves it off and
 * reads the daemon's snapshot, so it never double-scans. Absence ⇒ a quiet
 * empty set. Mirrors the SDK's own createRuntimeServices wiring.
 */
import { computeUsageCostUsd, type ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { type ArchivableProcessRegistry } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { ObservedAgentSource } from '@pellux/goodvibes-sdk/platform/runtime/fleet/observed';
import { createArchivableFleetRegistry, type ProcessRegistryDeps } from '@pellux/goodvibes-terminal-shell';

export interface FleetServicesDeps
  extends Omit<ProcessRegistryDeps, 'observedAgents' | 'priceUsage'> {
  /** Turns on the daemon-side observed foreign-agent source (daemon only). */
  readonly observeExternalAgents?: boolean | undefined;
  /** Backs the honest pricing resolver folded into priceUsage below. */
  readonly providerRegistry: Pick<ProviderRegistry, 'resolveModelPricing'>;
}

export function createFleetServices(
  deps: FleetServicesDeps,
): { processRegistry: ArchivableProcessRegistry } {
  const { observeExternalAgents, providerRegistry, ...registryDeps } = deps;
  const observedAgents = observeExternalAgents ? new ObservedAgentSource() : undefined;
  const processRegistry = createArchivableFleetRegistry({
    ...registryDeps,
    observedAgents, // Daemon-side observed foreign-agent rows (undefined in the interactive process)
    // Honest-unpriced through the ONE pricing resolver (manual -> registration -> provider-served
    // -> catalog -> unknown); unknown/subscription yields null, never $0. Mirrors the SDK composition.
    priceUsage: (model, usage) => (model ? computeUsageCostUsd(providerRegistry.resolveModelPricing(model), usage) : null),
  });
  return { processRegistry };
}
