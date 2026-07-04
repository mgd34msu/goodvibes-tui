import type { PanelManager } from '../panel-manager.ts';
import { FleetPanel } from '../fleet-panel.ts';
import { createFleetReadModel } from '../fleet-read-model.ts';
import { ServicesPanel } from '../services-panel.ts';
import { SubscriptionPanel } from '../subscription-panel.ts';
import { LocalAuthPanel } from '../local-auth-panel.ts';
import { SettingsSyncPanel } from '../settings-sync-panel.ts';
import { SandboxPanel } from '../sandbox-panel.ts';
import { RemotePanel } from '../remote-panel.ts';
import { ProviderHealthPanel } from '../provider-health-panel.ts';
import { createProviderRuntimeInspectionQuery } from '../../runtime/ui-service-queries.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import { selectModel } from '../../runtime/store/selectors/index.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';
import { registerEcosystemModalRedirects } from '../modals/modal-surface.ts';

// WO-152: the former single 'monitoring' category (33 panels pre-merge) is
// split into five operator domains, applied per-registration below. Kept in
// this file's original registration order (rather than physically regrouped
// by category) because several registrations below close over shared local
// state — `ui`, `providerRuntime`, `runtimeStore` — defined once near the
// top of this function. Domain membership registered here:
//   providers:              services, subscription, remote, provider-health
//   security-policy:        local-auth, settings-sync, security, sandbox, policy
//   automation-control:     plugins, skills, hooks, marketplace
//
// W6.1 (the purge): cockpit, approval, automation, routes, control-plane,
// worktrees, tasks, orchestration, ops, ops-control, and communication were
// RETIRE-INTO-FLEET (their live views are subsumed by the Fleet panel below
// — each id now redirects there via registerAlias); debug and eval were
// DELETE-disposition (no surviving human surface). See
// .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1) for the full
// disposition map. The rosterReadModel/agent-lifecycle wiring that used to
// feed CockpitPanel exclusively was removed along with it — Fleet reads the
// process registry directly via fleetReadModel below, not via the roster
// read-model.
export function registerOperationsPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);
  const providerRuntime = createProviderRuntimeInspectionQuery(createRuntimeProviderApi({
    benchmarkStore: ui.providers.benchmarkStore,
    favoritesStore: ui.providers.favoritesStore,
    providerRegistry: ui.providers.providerRegistry,
  }));
  const runtimeStore = deps.runtimeStore;

  // W2.2: Fleet — the live unified process tree, read from the single
  // process registry constructed once in runtime/services.ts (shared with
  // every other consumer rather than duplicated here; the registry owns its
  // own coalesced tick, so no manual lifecycle-event wiring is needed).
  // Wave-3 (W3.2): runtimeBus is also passed so the read model can subscribe
  // to the honest COMMUNICATION_CONSUMED steer-ack signal (fleet-read-model.ts).
  const fleetReadModel = createFleetReadModel(ui.runtime.processRegistry, ui.runtime.runtimeBus);

  manager.registerType({
    id: 'fleet',
    name: 'Fleet',
    // W2.2: '⊟' verified free against the full icon registry at wiring time.
    icon: '⊟',
    category: 'runtime-ops',
    description: 'Live unified process tree: agents, WRFC chains, workflows, watchers, and background processes, with interrupt/kill/steer controls',
    factory: () => new FleetPanel(fleetReadModel, {
      interrupt: (id: string) => fleetReadModel.interrupt(id),
      kill: (id: string, opts: { cascade: boolean }) => fleetReadModel.kill(id, opts),
      // Wave-3 (C6): full-fidelity transcript source for an attached agent
      // tab — live while the agent runs, frozen briefly after it completes
      // (AgentManager's bounded retention ring), empty once evicted (the
      // panel degrades to the on-disk ledger fallback in that case).
      getConversationSnapshot: (agentId: string) => ui.agents.agentManager.getConversationSnapshot(agentId),
      resolveSessionLogPath: (agentId: string) => ui.environment.shellPaths.resolveProjectPath('tui', 'sessions', `${agentId}.jsonl`),
      // Wave-3 (W3.2): queue a message for a live in-process agent/wrfc-subtask member.
      steer: (id: string, text: string) => fleetReadModel.steer(id, text),
    }, deps.configManager),
  });

  // Compat: '/panel open <id>' (and any saved layout/muscle memory) for
  // every retired runtime-ops console still resolves — redirected to fleet,
  // which absorbs orchestration, permissions, communication, task, and
  // process-tree views (see FleetPanel's own description above).
  manager.registerAlias('cockpit', 'fleet');
  manager.registerAlias('approval', 'fleet');
  manager.registerAlias('automation', 'fleet');
  manager.registerAlias('routes', 'fleet');
  manager.registerAlias('control-plane', 'fleet');
  manager.registerAlias('worktrees', 'fleet');
  manager.registerAlias('tasks', 'fleet');
  manager.registerAlias('orchestration', 'fleet');
  manager.registerAlias('ops', 'fleet');
  manager.registerAlias('ops-control', 'fleet');
  manager.registerAlias('communication', 'fleet');
  manager.registerAlias('incident', 'fleet');
  // Re-pointed: forensics used to resolve to the (now-retired) incident
  // workspace (WO-114); both ids now land on fleet directly — alias
  // resolution is a single hop, so this cannot chain through 'incident'.
  manager.registerAlias('forensics', 'fleet');

  // W6.1 (the purge) — group B: 'plugins' and 'skills' migrated to the
  // 'plugins' / 'skills' config-modals (see registerEcosystemModalRedirects at
  // the end of this function and src/panels/modals/). Their panel
  // registrations are retired here.

  manager.registerType({
    id: 'services',
    name: 'Services',
    icon: 'V',
    category: 'providers',
    description: 'Configured external services, credential presence, and connection health tests',
    factory: () => new ServicesPanel(deps.serviceRegistry, deps.subscriptionManager),
  });

  manager.registerType({
    id: 'subscription',
    name: 'Subscriptions',
    icon: 'B',
    category: 'providers',
    description: 'OAuth-backed provider subscriptions and supported provider override posture',
    factory: () => new SubscriptionPanel(deps.serviceRegistry, deps.subscriptionManager),
  });

  manager.registerType({
    id: 'local-auth',
    name: 'Local Auth',
    icon: 'U',
    category: 'security-policy',
    description: 'Local daemon/listener auth users, bootstrap posture, and active sessions',
    factory: () => new LocalAuthPanel(deps.localUserAuthManager),
  });

  manager.registerType({
    id: 'settings-sync',
    name: 'Settings Sync',
    // WO-152: registry previously said 'Y' while the live panel's own
    // super() call used 'S' — a pre-existing registry/instance mismatch as
    // well as a collision ('Y' with communication/eval, 'S' with symbols).
    // Unified to a single unique glyph in both places.
    icon: '▱',
    category: 'security-policy',
    description: 'Local, synced, and managed settings posture with recent sync events and active locks',
    factory: () => new SettingsSyncPanel(deps.configManager),
  });

  // W6.1 (the purge) — group B: 'hooks', 'security', and 'marketplace'
  // migrated to config-modals (see registerEcosystemModalRedirects below).
  // Their panel registrations are retired here.

  manager.registerType({
    id: 'sandbox',
    name: 'Sandbox',
    // WO-152: was 'X' (collided with tools).
    icon: '▪',
    category: 'security-policy',
    description: 'VM isolation posture for MCP servers and evaluation runtimes',
    factory: () => new SandboxPanel(deps.configManager, deps.sandboxSessionRegistry, deps.requestRender),
  });

  manager.registerType({
    id: 'remote',
    name: 'Remote',
    // WO-152: was 'R' (collided with routes).
    icon: '▰',
    category: 'providers',
    description: 'Self-hosted daemon and ACP transport state with active remote connections',
    factory: () => new RemotePanel(ui.readModels.remote),
  });

  manager.registerType({
    id: 'provider-health',
    name: 'Health',
    icon: 'N',
    category: 'providers',
    description: 'Provider console: status, latency timelines, error attribution, auth routes, fallback chain, and repair actions',
    // W6.1: preload dropped — provider-health is MIGRATE-TO-MODAL (not yet
    // converted; WO-A). Only 'tokens' remains preloaded post-purge.
    retainOnClose: true,
    factory: () => new ProviderHealthPanel(
      providerRuntime,
      {
        configManager: deps.configManager,
        turnEvents: ui.events.turns,
        providerEvents: ui.events.providers,
        providers: ui.readModels.providers,
        session: ui.readModels.session,
        security: ui.readModels.security,
        localAuth: ui.readModels.localAuth,
        settings: ui.readModels.settings,
        remote: ui.readModels.remote,
        intelligence: ui.readModels.intelligence,
        continuity: ui.readModels.continuity,
        worktrees: ui.readModels.worktrees,
        ...(runtimeStore
          ? {
            modelState: {
              get: () => selectModel(runtimeStore.getState()),
              subscribe: (listener: () => void) => runtimeStore.subscribe(listener),
            },
          }
          : {}),
      },
      deps.requestRender,
    ),
  });

  // WO-112 compat (wired at integration): the retired 'providers' and
  // 'accounts' panel ids still resolve — redirected to the merged
  // provider-health console. '/accounts panel|open' depends on the
  // 'accounts' alias.
  manager.registerAlias('providers', 'provider-health');
  manager.registerAlias('accounts', 'provider-health');

  // W6.1 (the purge) — group B: 'policy' migrated to the 'policy' config-modal.
  // Its panel registration is retired here.

  // W6.1 (the purge) — group B: register the ecosystem/governance panel→modal
  // redirects so `/panel open <id>` and saved layouts resolve to the modal
  // (via the injected openModal callback) instead of a retired panel. Config +
  // dispatch registration with the WO-A host is a separate one-call step
  // (registerEcosystemModals) wired by the integrator.
  registerEcosystemModalRedirects(manager);
}
