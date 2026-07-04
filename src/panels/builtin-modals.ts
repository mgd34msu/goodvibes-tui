import type { PanelManager } from './panel-manager.ts';
import { requireUiServices, type ResolvedBuiltinPanelDeps } from './builtin/shared.ts';
import { createProviderRuntimeInspectionQuery } from '../runtime/ui-service-queries.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import { createServicesModalSurface } from './modals/services-modal.ts';
import { createSubscriptionModalSurface } from './modals/subscription-modal.ts';
import { createRemoteModalSurface } from './modals/remote-modal.ts';
import { createSettingsSyncModalSurface } from './modals/settings-sync-modal.ts';
import { createProviderHealthModalSurface } from './modals/provider-health-modal.ts';
import { createLocalAuthModalSurface } from './modals/local-auth-modal.ts';
import { createSandboxModalSurface } from './modals/sandbox-modal.ts';

/**
 * Register the config-modal surfaces + their panel-id redirects (W6.1, the
 * purge). Called once at startup from registerBuiltinPanels, AFTER the panels'
 * deps are resolved (the surfaces close over the same read-models the retired
 * panels used). For each MIGRATE-TO-MODAL surface this does two things:
 *   1. registerModalSurface — the data + actions the config-modal host renders.
 *   2. registerModalRedirect — so `/panel open <old-id>`, saved layouts, and any
 *      alias still resolve to the modal (open() invokes the openModal callback
 *      instead of constructing the deleted panel).
 *
 * WO-A owns the Providers & Connectivity group below; WO-B adds the
 * Ecosystem & Governance surfaces to this same function.
 */
export function registerBuiltinModals(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);

  // ── Providers & Connectivity (WO-A) ─────────────────────────────────────────
  manager.registerModalSurface(createServicesModalSurface(deps.serviceRegistry, deps.subscriptionManager));
  manager.registerModalRedirect('services', 'services-modal');

  manager.registerModalSurface(createSubscriptionModalSurface(deps.serviceRegistry, deps.subscriptionManager));
  manager.registerModalRedirect('subscription', 'subscription-modal');

  manager.registerModalSurface(createRemoteModalSurface(ui.readModels.remote));
  manager.registerModalRedirect('remote', 'remote-modal');

  // provider-health is the charter's live-modal exemplar; 'providers' and
  // 'accounts' were panel aliases to it (operations.ts) and now redirect to the
  // same modal. providerRuntime is built exactly as the retired panel built it.
  const providerRuntime = createProviderRuntimeInspectionQuery(createRuntimeProviderApi({
    benchmarkStore: ui.providers.benchmarkStore,
    favoritesStore: ui.providers.favoritesStore,
    providerRegistry: ui.providers.providerRegistry,
  }));
  manager.registerModalSurface(createProviderHealthModalSurface(providerRuntime, ui.readModels.providers));
  manager.registerModalRedirect('provider-health', 'providers-modal');
  manager.registerModalRedirect('providers', 'providers-modal');
  manager.registerModalRedirect('accounts', 'providers-modal');

  // ── Security & Governance (WO-A subset) ─────────────────────────────────────
  manager.registerModalSurface(createSettingsSyncModalSurface(deps.configManager));
  manager.registerModalRedirect('settings-sync', 'settings-sync-modal');

  manager.registerModalSurface(createLocalAuthModalSurface(deps.localUserAuthManager));
  manager.registerModalRedirect('local-auth', 'local-auth-modal');

  manager.registerModalSurface(createSandboxModalSurface(deps.configManager, deps.sandboxSessionRegistry, deps.requestRender));
  manager.registerModalRedirect('sandbox', 'sandbox-modal');
}
