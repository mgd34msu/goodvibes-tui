import type { PanelManager } from './panel-manager.ts';
import { requireUiServices, type ResolvedBuiltinPanelDeps } from './builtin/shared.ts';
import type { ConfigModalSurface, ConfigModalView } from '../input/config-modal-types.ts';
import { createProviderRuntimeInspectionQuery } from '../runtime/ui-service-queries.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import { copyToClipboard } from '../utils/clipboard.ts';
import { ensurePublicBaseUrl } from '../cli/pairing-origin.ts';
import { availablePairingOffers, mintPairingHandoff, defaultPairingTokenName } from '../cli/pairing-handoff.ts';
// ── Providers & Connectivity + Security subset ────────────────────────────────
import { createServicesModalSurface } from './modals/services-modal.ts';
import { createSubscriptionModalSurface } from './modals/subscription-modal.ts';
import { createRemoteModalSurface } from './modals/remote-modal.ts';
import { createSettingsSyncModalSurface } from './modals/settings-sync-modal.ts';
import { createProviderHealthModalSurface } from './modals/provider-health-modal.ts';
import { createLocalAuthModalSurface } from './modals/local-auth-modal.ts';
import { createSandboxModalSurface } from './modals/sandbox-modal.ts';
// ── Ecosystem & Governance ─────────────────────────────────────────────────
import { createMarketplaceModalSurface } from './modals/marketplace-modal.ts';
import { createPluginsModalSurface } from './modals/plugins-modal.ts';
import { createSkillsModalSurface } from './modals/skills-modal.ts';
import { createHooksModalSurface } from './modals/hooks-modal.ts';
import { createSecurityModalSurface } from './modals/security-modal.ts';
import { createPolicyModalSurface } from './modals/policy-modal.ts';
import { createKnowledgeModalSurface } from './modals/knowledge-modal.ts';
import { createMemoryModalSurface, type MemoryModalDeps } from './modals/memory-modal.ts';
import { createWorkPlanModalSurface } from './modals/work-plan-modal.ts';
import { createKeybindingsModalSurface } from './modals/keybindings-modal.ts';
import { createPairingModalSurface, type PairingModalConnectionInfo } from './modals/pairing-modal.ts';
import { createPlanningModalSurface } from './modals/planning-modal.ts';

/**
 * Register the config-modal surfaces + their panel-id redirects, from a prior
 * panel-consolidation cleanup. Called once at startup from registerBuiltinPanels, AFTER the panels'
 * deps are resolved (the surfaces close over the same read-models the retired
 * panels used). For each surface migrated from a standalone panel this does two things:
 *   1. registerModalSurface — the data + actions the config-modal host renders.
 *   2. registerModalRedirect — so `/panel open <old-id>`, saved layouts, and any
 *      alias still resolve to the modal.
 *
 * The Providers & Connectivity + Security subset is registered first, followed by the
 * Ecosystem & Governance set — the 12 ported config-modal
 * surfaces plus the `sessions` fold into the existing session-picker modal.
 */
export function registerBuiltinModals(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);

  // ── Providers & Connectivity ─────────────────────────────────────────────────
  manager.registerModalSurface(createServicesModalSurface(deps.serviceRegistry, deps.subscriptionManager));
  manager.registerModalRedirect('services', 'services-modal');

  manager.registerModalSurface(createSubscriptionModalSurface(deps.serviceRegistry, deps.subscriptionManager));
  manager.registerModalRedirect('subscription', 'subscription-modal');

  manager.registerModalSurface(createRemoteModalSurface(ui.readModels.remote));
  manager.registerModalRedirect('remote', 'remote-modal');

  const providerRuntime = createProviderRuntimeInspectionQuery(createRuntimeProviderApi({
    benchmarkStore: ui.providers.benchmarkStore,
    favoritesStore: ui.providers.favoritesStore,
    providerRegistry: ui.providers.providerRegistry,
  }));
  manager.registerModalSurface(createProviderHealthModalSurface(providerRuntime, ui.readModels.providers));
  manager.registerModalRedirect('provider-health', 'providers-modal');
  manager.registerModalRedirect('providers', 'providers-modal');
  manager.registerModalRedirect('accounts', 'providers-modal');

  // ── Security & Governance ────────────────────────────────────────────────────
  manager.registerModalSurface(createSettingsSyncModalSurface(deps.configManager));
  manager.registerModalRedirect('settings-sync', 'settings-sync-modal');

  // local-auth-modal is reached via the /local-auth front-door only; no
  // redirect (the 'local-auth' panel id must keep resolving to LocalAuthPanel
  // for the masked password-entry path). See builtin/operations.ts.
  manager.registerModalSurface(createLocalAuthModalSurface(deps.localUserAuthManager));

  manager.registerModalSurface(createSandboxModalSurface(deps.configManager, deps.sandboxSessionRegistry, deps.requestRender));
  manager.registerModalRedirect('sandbox', 'sandbox-modal');

  // ── Ecosystem & Governance ───────────────────────────────────────────────────
  manager.registerModalSurface(createMarketplaceModalSurface({
    readModel: ui.readModels.marketplace,
    ecosystemPaths: {
      cwd: ui.environment.shellPaths.workingDirectory,
      homeDir: ui.environment.shellPaths.homeDirectory,
      projectCatalogRoot: ui.environment.shellPaths.resolveProjectPath('tui', 'ecosystem'),
      userCatalogRoot: ui.environment.shellPaths.resolveUserPath('tui', 'ecosystem'),
    },
  }));
  manager.registerModalRedirect('marketplace', 'marketplace-modal');

  // plugins/hooks/knowledge deps are wired at bootstrap in production
  // (bootstrap-shell.ts) but may be absent in a partially-wired context (e.g. a
  // release-gate harness) — register a degraded placeholder rather than throw,
  // so the surface + redirect always resolve (the "always register, degrade
  // honestly" charter pattern).
  manager.registerModalSurface(deps.pluginManager
    ? createPluginsModalSurface({ pluginManager: deps.pluginManager })
    : unwiredSurface('plugins-modal', 'Plugins', 'Plugin manager not wired into this session.'));
  manager.registerModalRedirect('plugins', 'plugins-modal');

  manager.registerModalSurface(createSkillsModalSurface({
    shellPaths: {
      workingDirectory: ui.environment.shellPaths.workingDirectory,
      homeDirectory: ui.environment.shellPaths.homeDirectory,
    },
    ecosystemPaths: {
      cwd: ui.environment.shellPaths.workingDirectory,
      homeDir: ui.environment.shellPaths.homeDirectory,
      projectCatalogRoot: ui.environment.shellPaths.resolveProjectPath('tui', 'ecosystem'),
      userCatalogRoot: ui.environment.shellPaths.resolveUserPath('tui', 'ecosystem'),
    },
  }));
  manager.registerModalRedirect('skills', 'skills-modal');

  manager.registerModalSurface(deps.hookDispatcher && deps.hookWorkbench && deps.hookActivityTracker
    ? createHooksModalSurface({ hookDispatcher: deps.hookDispatcher, hookWorkbench: deps.hookWorkbench, hookActivityTracker: deps.hookActivityTracker })
    : unwiredSurface('hooks-modal', 'Hooks', 'Hook dispatcher/workbench not wired into this session.'));
  manager.registerModalRedirect('hooks', 'hooks-modal');

  manager.registerModalSurface(createSecurityModalSurface({ readModel: ui.readModels.security }));
  manager.registerModalRedirect('security', 'security-modal');

  manager.registerModalSurface(createPolicyModalSurface({ policyRuntimeState: deps.policyRuntimeState }));
  manager.registerModalRedirect('policy', 'policy-modal');

  manager.registerModalSurface(deps.knowledgeApi
    ? createKnowledgeModalSurface({ knowledgeApi: deps.knowledgeApi })
    : unwiredSurface('knowledge-modal', 'Knowledge', 'Knowledge API not wired into this session.'));
  manager.registerModalRedirect('knowledge', 'knowledge-modal');

  manager.registerModalSurface(createMemoryModalSurface({
    memoryRegistry: deps.memoryRegistry as MemoryModalDeps['memoryRegistry'],
  }));
  manager.registerModalRedirect('memory', 'memory-modal');

  manager.registerModalSurface(createWorkPlanModalSurface({ workPlanStore: deps.workPlanStore }));
  manager.registerModalRedirect('work-plan', 'work-plan-modal');

  manager.registerModalSurface(createKeybindingsModalSurface({
    toolRegistry: deps.toolRegistry,
    providerRegistry: deps.providerRegistry,
    keybindingsManager: ui.shell.keybindingsManager,
  }));
  manager.registerModalRedirect('docs', 'keybindings-modal');

  manager.registerModalSurface(createPairingModalSurface({
    getConnectionInfo: () => buildPairingConnectionInfo(deps),
    controlPlaneReadModel: ui.readModels.controlPlane,
    copyToClipboard,
  }));
  manager.registerModalRedirect('qr-code', 'pairing-modal');

  manager.registerModalSurface(createPlanningModalSurface({
    service: deps.projectPlanningService,
    projectId: deps.projectPlanningProjectId,
    requestRender: deps.requestRender,
  }));
  manager.registerModalRedirect('project-planning', 'planning-modal');

  // The retired 'sessions' panel folds into the EXISTING session-picker modal
  // (no new config-modal surface); the redirect is a plain hand-off, moved here
  // from the deleted ecosystem bridge.
  manager.registerModalRedirect('sessions', 'sessionPicker');
}

/**
 * Build the companion-pairing connection info lazily (called from the pairing
 * surface's first render, not at registration time) so a missing daemon home
 * degrades to an honest "unavailable" modal instead of throwing at startup.
 * Mirrors the retired QrPanel factory's construction.
 */
function buildPairingConnectionInfo(deps: ResolvedBuiltinPanelDeps): PairingModalConnectionInfo | null {
  try {
    const ui = requireUiServices(deps);
    const configManager = deps.configManager;
    // Freeze a stable web origin once (never clobbering a user-set value).
    const webOrigin = ensurePublicBaseUrl(configManager);
    const offers = availablePairingOffers({
      relayEnabled: configManager.get('relay.enabled') === true,
      // The TUI composition always wires a step-up service ⇒ the passkey offer is
      // presentable; the web app declines it if the device has no authenticator.
      stepUpAvailable: true,
    });
    // Mint a fresh per-device token and encode the canonical `#pair=` deep link —
    // the same mint the pairing.handoff.create verb performs, no raw JSON blob.
    const handoff = mintPairingHandoff({
      pairingTokens: ui.platform.pairingTokens,
      name: defaultPairingTokenName(),
      offers,
      webOrigin: webOrigin.origin,
    });
    return {
      url: webOrigin.origin,
      token: handoff.token.token,
      tokenName: handoff.token.name,
      deepLink: handoff.deepLink ?? handoff.fragment,
      offers: handoff.offers,
      httpOnLan: webOrigin.httpOnLan,
    };
  } catch {
    return null;
  }
}

/** A minimal config-modal surface that renders an honest "not wired" degraded
 *  state — used when a group-B surface's bootstrap dependency is absent. */
function unwiredSurface(name: string, title: string, reason: string): ConfigModalSurface {
  return {
    name,
    title,
    buildView: (): ConfigModalView => ({ title, degraded: reason, tabs: [{ id: 'main', label: title, rows: [] }] }),
  };
}

