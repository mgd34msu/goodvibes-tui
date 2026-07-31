import type { OrchestratorCoreServices } from '@pellux/goodvibes-sdk/platform/core';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { RuntimeServices } from './services.ts';
import { isCodeInjectionSettingEnabled } from '@pellux/goodvibes-sdk/platform/runtime/operations';

/** The slice of the runtime services bag the shared orchestrator payload draws from. */
export type OrchestratorCoreServicesSource = Pick<
  RuntimeServices,
  | 'planManager'
  | 'adaptivePlanner'
  | 'sessionMemoryStore'
  | 'sessionLineageTracker'
  | 'idempotencyStore'
  | 'memorySpine'
  | 'codeIndexStore'
  | 'codeIndexReindexScheduler'
>;

/**
 * The single source of truth for the `Orchestrator.setCoreServices()` payload
 * fields shared by BOTH call sites (runtime/bootstrap.ts and main.ts). Each
 * site spreads this and adds its own site-specific extras (bootstrap:
 * cacheHitTracker; main: favoritesStore) — setCoreServices() merges, so the
 * later main.ts call only overlays, never erases.
 *
 * BLOCKER regression guard: `memoryRegistry` here is what turns
 * on per-turn passive knowledge injection for the MAIN interactive session —
 * the SDK turn loop hard-gates on `coreServices.memoryRegistry` (undefined is
 * a silent no-op: Orchestrator.getTurnInjections() stays empty forever and
 * `/recall injections` renders a misleading empty state). Both call sites once
 * omitted it independently; routing them through this one function (with
 * src/test/runtime/orchestrator-core-services.test.ts pinning the field) is
 * what keeps that from regressing.
 *
 * SDK 1.2.0 FULL DETACH: the SDK's turn loop reads `memoryRegistry.getAll()`
 * SYNCHRONOUSLY (`TurnKnowledgeRegistrySource`), but the memory spine's wire
 * reads are asynchronous — a sync function cannot await the wire. Per
 * docs/decisions/2026-07-06-memory-wire-full-detach.md (SDK repo) this is
 * satisfied by the spine's freshness-stamped recall snapshot instead of the
 * raw local `memoryRegistry`: `getAll()` reads `memorySpine.recallSnapshot()`,
 * which returns whatever the last `refreshRecallSnapshot()` (an async
 * pre-turn hook — see the `handleUserInput` call sites) captured, honestly
 * empty/stale until refreshed. This is what lets per-turn knowledge injection
 * detach from the local store file when a daemon is adopted, instead of
 * always reading the (possibly divergent) local registry regardless of mode.
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
    memoryRegistry: { getAll: () => services.memorySpine.recallSnapshot().records },
    // Main-session code auto-injection + tool-site reindex. Injection is
    // additionally gated by the default-off `agent-passive-code-injection` flag inside the
    // SDK; here we supply the source, the live storage.codeIndexEnabled predicate, and the
    // reindex scheduler.
    codeIndex: services.codeIndexStore,
    isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager),
    codeIndexReindexScheduler: services.codeIndexReindexScheduler,
  };
}

/**
 * The async pre-turn hook: refreshes the memory spine's recall snapshot over
 * the CURRENT route (wire when adopted, local otherwise) so the synchronous
 * per-turn knowledge injection (`memoryRegistry.getAll()` above) reads
 * up-to-date records instead of whatever the previous refresh captured.
 * Failures are swallowed — an honest stale/empty snapshot (with its own
 * degradation note, surfaced via `recallSnapshot().note`) is preferable to
 * blocking the user's turn on a memory-read failure.
 */
export async function refreshMemoryRecallSnapshot(services: Pick<RuntimeServices, 'memorySpine'>): Promise<void> {
  await services.memorySpine.refreshRecallSnapshot().catch(() => {});
}
