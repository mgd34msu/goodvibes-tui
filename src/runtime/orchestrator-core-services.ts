import type { OrchestratorCoreServices } from '@pellux/goodvibes-sdk/platform/core';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { RuntimeServices } from './services.ts';

/** The slice of the runtime services bag the shared orchestrator payload draws from. */
export type OrchestratorCoreServicesSource = Pick<
  RuntimeServices,
  | 'planManager'
  | 'adaptivePlanner'
  | 'sessionMemoryStore'
  | 'sessionLineageTracker'
  | 'idempotencyStore'
  | 'memoryRegistry'
>;

/**
 * The single source of truth for the `Orchestrator.setCoreServices()` payload
 * fields shared by BOTH call sites (runtime/bootstrap.ts and main.ts). Each
 * site spreads this and adds its own site-specific extras (bootstrap:
 * cacheHitTracker; main: favoritesStore) — setCoreServices() merges, so the
 * later main.ts call only overlays, never erases.
 *
 * Wave-5 (wo805) BLOCKER regression guard: `memoryRegistry` here is what turns
 * on per-turn passive knowledge injection for the MAIN interactive session —
 * the SDK turn loop hard-gates on `coreServices.memoryRegistry` (undefined is
 * a silent no-op: Orchestrator.getTurnInjections() stays empty forever and
 * `/recall injections` renders a misleading empty state). Both call sites once
 * omitted it independently; routing them through this one function (with
 * src/test/runtime/orchestrator-core-services.test.ts pinning the field) is
 * what keeps that from regressing.
 */
export function buildSharedOrchestratorCoreServices(input: {
  readonly services: OrchestratorCoreServicesSource;
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
}): OrchestratorCoreServices {
  const { services, configManager, providerRegistry } = input;
  return {
    configManager,
    providerRegistry,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    idempotencyStore: services.idempotencyStore,
    memoryRegistry: services.memoryRegistry,
  };
}
