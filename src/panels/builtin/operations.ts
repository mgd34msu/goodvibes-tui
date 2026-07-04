import type { PanelManager } from '../panel-manager.ts';
import { CockpitPanel } from '../cockpit-panel.ts';
import { FleetPanel } from '../fleet-panel.ts';
import { createFleetReadModel } from '../fleet-read-model.ts';
import { AgentInspectorPanel } from '../agent-inspector-panel.ts';
import { ApprovalPanel } from '../approval-panel.ts';
import { PluginsPanel } from '../plugins-panel.ts';
import { SkillsPanel } from '../skills-panel.ts';
import { ServicesPanel } from '../services-panel.ts';
import { AutomationControlPanel } from '../automation-control-panel.ts';
import { RoutesPanel } from '../routes-panel.ts';
import { ControlPlanePanel } from '../control-plane-panel.ts';
import { SubscriptionPanel } from '../subscription-panel.ts';
import { LocalAuthPanel } from '../local-auth-panel.ts';
import { SettingsSyncPanel } from '../settings-sync-panel.ts';
import { WorktreePanel } from '../worktree-panel.ts';
import { HooksPanel } from '../hooks-panel.ts';
import { SecurityPanel } from '../security-panel.ts';
import { MarketplacePanel } from '../marketplace-panel.ts';
import { SandboxPanel } from '../sandbox-panel.ts';
import { TasksPanel } from '../tasks-panel.ts';
import { OrchestrationPanel } from '../orchestration-panel.ts';
import { OpsStrategyPanel } from '../ops-strategy-panel.ts';
import { OpsControlPanel } from '../ops-control-panel.ts';
import { CommunicationPanel } from '../communication-panel.ts';
import { RemotePanel } from '../remote-panel.ts';
import { ProviderHealthPanel } from '../provider-health-panel.ts';
import { DebugPanel } from '../debug-panel.ts';
import { IncidentReviewPanel } from '../incident-review-panel.ts';
import { PolicyPanel } from '../policy-panel.ts';
import { EvalPanel } from '../eval-panel.ts';
import { createProviderRuntimeInspectionQuery } from '../../runtime/ui-service-queries.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import { selectModel } from '../../runtime/store/selectors/index.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireAutomationManager, requireControlPlanePanelDeps, requireHookPanelDeps, requirePluginManager, requireUiServices, withUnconfiguredFallback } from './shared.ts';
import { createCockpitRosterReadModel } from '../cockpit-read-model.ts';

// WO-152: the former single 'monitoring' category (33 panels pre-merge) is
// split into five operator domains, applied per-registration below. Kept in
// this file's original registration order (rather than physically regrouped
// by category) because several registrations below close over shared local
// state — `ui`, `providerRuntime`, `runtimeStore`, `rosterReadModel` — defined
// once near the top of this function. Domain membership registered here:
//   providers:              services, subscription, remote, provider-health
//   security-policy:        approval, local-auth, settings-sync, security, sandbox, policy
//   automation-control:     plugins, skills, automation, worktrees, hooks, marketplace
//   incidents-diagnostics:  debug, incident, eval
//   runtime-ops:            cockpit, routes, control-plane, tasks, orchestration,
//                           ops, ops-control, communication (plus system-messages
//                           and tokens/cost, registered in builtin/session.ts
//                           and builtin/development.ts respectively)
export function registerOperationsPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  const ui = requireUiServices(deps);
  const providerRuntime = createProviderRuntimeInspectionQuery(createRuntimeProviderApi({
    benchmarkStore: ui.providers.benchmarkStore,
    favoritesStore: ui.providers.favoritesStore,
    providerRegistry: ui.providers.providerRegistry,
  }));
  const runtimeStore = deps.runtimeStore;

  const rosterReadModel = createCockpitRosterReadModel(ui.agents.agentManager);
  // Subscribe to agent lifecycle events so the roster re-renders on state changes.
  // AGENT_RUNNING covers status transitions; AGENT_CANCELLED covers the cancellation
  // terminal state not emitted by AGENT_FAILED. Noisy mid-run events (STREAM_DELTA,
  // AWAITING_TOOL, etc.) are intentionally excluded — they don't affect roster fields.
  // Note: stall detection is time-based, so stalled/stalledAgentCount will only refresh
  // on the next lifecycle event; a periodic tick would be needed for real-time stall display.
  ui.events.agents.on('AGENT_SPAWNING', () => rosterReadModel.markDirty());
  ui.events.agents.on('AGENT_RUNNING', () => rosterReadModel.markDirty());
  ui.events.agents.on('AGENT_COMPLETED', () => rosterReadModel.markDirty());
  ui.events.agents.on('AGENT_FAILED', () => rosterReadModel.markDirty());
  ui.events.agents.on('AGENT_CANCELLED', () => rosterReadModel.markDirty());

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

  manager.registerType({
    id: 'cockpit',
    name: 'Cockpit',
    icon: 'O',
    category: 'runtime-ops',
    description: 'Unified operator summary for orchestration, permissions, communication, MCP, plugins, and integrations',
    factory: () => new CockpitPanel(
      ui.readModels.cockpit,
      rosterReadModel,
      {
        openAgentDetail: (agentId: string) => deps.openAgentDetail?.(agentId),
        cancelAgent: (agentId: string) => ui.agents.agentManager.cancel(agentId),
        // WO-130: roster Enter jumps to the Inspector console (WO-110's
        // inspectAgent deep-link target) instead of only the quick-peek modal.
        inspectAgent: (agentId: string) => {
          const panel = manager.open('inspector');
          if (panel instanceof AgentInspectorPanel) panel.inspectAgent(agentId);
        },
        openPanel: (panelId: string) => deps.openPanel?.(panelId),
      },
    ),
  });

  manager.registerType({
    id: 'approval',
    name: 'Approval',
    icon: 'A',
    category: 'security-policy',
    description: 'Action-specific approval workspace for why-prompted, why-denied, and what-if review',
    factory: () => new ApprovalPanel(deps.policyRuntimeState),
  });

  manager.registerType({
    id: 'plugins',
    name: 'Plugins',
    // WO-152: was 'P' (collided with project-planning and preview).
    icon: '◐',
    category: 'automation-control',
    description: 'Plugin trust, quarantine, capability, and activation status',
    factory: () => new PluginsPanel(requirePluginManager(deps)),
  });

  manager.registerType({
    id: 'skills',
    name: 'Skills',
    // WO-152: was 'K' (collided with knowledge and tokens).
    icon: '▩',
    category: 'automation-control',
    description: 'Project-local and global skill discovery with origin and dependency details',
    factory: () => new SkillsPanel({
      componentHealthMonitor: deps.componentHealthMonitor,
      shellPaths: ui.environment.shellPaths,
      ecosystemPaths: {
        cwd: ui.environment.shellPaths.workingDirectory,
        homeDir: ui.environment.shellPaths.homeDirectory,
        projectCatalogRoot: ui.environment.shellPaths.resolveProjectPath('tui', 'ecosystem'),
        userCatalogRoot: ui.environment.shellPaths.resolveUserPath('tui', 'ecosystem'),
      },
    }),
  });

  manager.registerType({
    id: 'services',
    name: 'Services',
    icon: 'V',
    category: 'providers',
    description: 'Configured external services, credential presence, and connection health tests',
    factory: () => new ServicesPanel(deps.serviceRegistry, deps.subscriptionManager),
  });

  manager.registerType({
    id: 'automation',
    name: 'Automation',
    // WO-152: was 'M' (collided with memory and marketplace).
    icon: '◨',
    category: 'automation-control',
    description: 'Automation jobs, runs, deliveries, and watcher-fed sources across the control plane, with real enable/disable and run-now controls',
    factory: () => new AutomationControlPanel(ui.readModels.automation, ui.readModels.watchers, {
      automationManager: requireAutomationManager(deps),
      watcherRegistry: deps.watcherRegistry,
    }),
  });

  manager.registerType({
    id: 'routes',
    name: 'Routes',
    icon: 'R',
    category: 'runtime-ops',
    description: 'Cross-surface route bindings and shared session attachment state',
    factory: () => new RoutesPanel(ui.readModels.routes),
  });

  manager.registerType({
    id: 'control-plane',
    name: 'Control Plane',
    icon: 'C',
    category: 'runtime-ops',
    description: 'Daemon control-plane state, clients, approvals, and recent operator activity',
    factory: () => new ControlPlanePanel(ui.readModels.controlPlane, requireControlPlanePanelDeps(deps)),
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

  manager.registerType({
    id: 'worktrees',
    name: 'Worktrees',
    // WO-152: was 'W' (collided with wrfc).
    icon: '▯',
    category: 'automation-control',
    description: 'Orchestrator-owned git worktree lifecycle, attachments, and cleanup state',
    factory: () => new WorktreePanel(deps.worktreeRegistry, deps.requestRender),
  });

  manager.registerType({
    id: 'hooks',
    name: 'Hooks',
    // WO-152: was 'H' (collided with sessions).
    icon: '▨',
    category: 'automation-control',
    description: 'Registered hooks, chains, contracts, and execution policy details',
    factory: () => {
      const hookDeps = requireHookPanelDeps(deps);
      return new HooksPanel(hookDeps.hookDispatcher, hookDeps.hookWorkbench, hookDeps.hookActivityTracker);
    },
  });

  manager.registerType({
    id: 'security',
    name: 'Security',
    // WO-152: was 'U' (collided with local-auth and policy).
    icon: '▬',
    category: 'security-policy',
    description: 'Security review workspace for token audit, policy posture, MCP quarantine, and incident pressure',
    factory: () => new SecurityPanel(ui.readModels.security),
  });

  manager.registerType({
    id: 'marketplace',
    name: 'Marketplace',
    // WO-152: was 'M' (collided with memory and automation).
    icon: '◩',
    category: 'automation-control',
    description: 'Curated plugin and skill marketplace with provenance, compatibility, and install posture',
    factory: () => {
      return new MarketplacePanel(ui.readModels.marketplace, {
        cwd: ui.environment.shellPaths.workingDirectory,
        homeDir: ui.environment.shellPaths.homeDirectory,
        projectCatalogRoot: ui.environment.shellPaths.resolveProjectPath('tui', 'ecosystem'),
        userCatalogRoot: ui.environment.shellPaths.resolveUserPath('tui', 'ecosystem'),
      });
    },
  });

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
    id: 'tasks',
    name: 'Tasks',
    // WO-152: was 'J' (collided with intelligence and system-messages).
    icon: '▦',
    category: 'runtime-ops',
    description: 'Queued, running, blocked, failed, and completed task summaries from the runtime store',
    factory: () => new TasksPanel(ui.readModels.tasks, ui.readModels.worktrees, deps.opsApi),
  });

  manager.registerType({
    id: 'orchestration',
    name: 'Orchestration',
    // WO-152: was 'Q' (collided with qr-code and ops-control).
    icon: '◒',
    category: 'runtime-ops',
    description: 'Task-graph status, node roles, and bounded recursion guard activity',
    factory: () => new OrchestrationPanel(ui.readModels.orchestration),
  });

  manager.registerType({
    id: 'ops',
    name: 'Ops',
    // WO-152: was 'O' (collided with cockpit). Also unifies a pre-existing
    // registry ('monitoring') / live-instance (ops-strategy-panel.ts said
    // 'agent') category mismatch onto a single 'runtime-ops' value.
    icon: '◫',
    category: 'runtime-ops',
    description: 'Adaptive planner strategy timeline, override posture, and recent execution-mode decisions',
    factory: () => new OpsStrategyPanel(ui.events.planner, deps.adaptivePlanner, deps.planRuntime),
  });

  // WO-120: the operator intervention console behind the operator-control-plane
  // feature flag. Registration is unconditional (matching the ControlPlanePanel
  // pattern above) — the flag itself gates whether bootstrap.ts wires the
  // openOpsPanel command-context callback and the Ctrl+O / `/ops view` route,
  // not whether the panel type resolves for direct `/panel open ops-control`.
  manager.registerType({
    id: 'ops-control',
    name: 'Ops Control',
    // WO-152: was 'Q' (collided with qr-code and orchestration). Also unifies
    // a pre-existing registry ('monitoring') / live-instance (ops-control-panel.ts
    // said 'agent') category mismatch onto a single 'runtime-ops' value.
    icon: '◓',
    category: 'runtime-ops',
    description: 'Operator intervention console: audit log plus cancel/pause/resume/retry on tasks and cancel on agents',
    factory: () => new OpsControlPanel(ui.events.ops, deps.opsApi),
  });

  manager.registerType({
    id: 'communication',
    name: 'Communication',
    icon: 'Y',
    category: 'runtime-ops',
    description: 'Structured agent communication, blocked routes, and delivery status',
    preload: true,
    retainOnClose: true,
    factory: () => new CommunicationPanel(
      ui.readModels.communication,
      (agentId: string) => deps.openAgentDetail?.(agentId),
    ),
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
    preload: true,
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

  manager.registerType({
    id: 'debug',
    name: 'Debug',
    // WO-152: was 'B' (collided with subscription).
    icon: '▧',
    category: 'incidents-diagnostics',
    description: 'API debug panel: per-call log with model, provider, tokens, latency, status, and error history',
    factory: () => {
      const panel = new DebugPanel(ui.events.turns, deps.requestRender);
      if (deps.orchestrator) panel.wireOrchestrator(deps.orchestrator);
      return panel;
    },
  });

  // WO-152: always registered (was gated behind `if (deps.forensicsRegistry)`,
  // so `/panel open incident` reported "Unknown panel" on builds without a
  // forensics registry wired). IncidentReviewPanel already accepts an
  // optional registry and renders its own "not configured" empty state when
  // it is absent, so no fallback wrapper is needed here — only the
  // conditional registration itself is removed.
  manager.registerType({
    id: 'incident',
    name: 'Incident',
    // WO-152: was 'N' (collided with provider-health).
    icon: '◪',
    category: 'incidents-diagnostics',
    description: 'Incident workspace with root cause, permission, budget, replay, causal-chain, phase-timing, and jump-link evidence',
    factory: () => new IncidentReviewPanel(deps.forensicsRegistry),
  });
  // WO-114 compat (Forensics merged into Incident): the retired 'forensics'
  // panel id still resolves — redirected to the merged Incident workspace so
  // pre-existing openForensicsPanel()/`/forensics` callers land on the same
  // Incident instance instead of stacking a duplicate registration.
  manager.registerAlias('forensics', 'incident');

  manager.registerType({
    id: 'policy',
    name: 'Policy',
    // WO-152: was 'U' (collided with local-auth and security).
    icon: '▭',
    category: 'security-policy',
    description: 'Policy governance: active/candidate bundles, divergence gate, rollout history, and simulation evidence',
    factory: () => new PolicyPanel(deps.policyRuntimeState),
  });

  // WO-152: always registered (was gated behind `if (deps.evalRegistry)`, so
  // `/panel open eval` reported "Unknown panel" on builds without an eval
  // registry wired). Falls back to a "dependency not configured" empty state.
  {
    const { evalRegistry } = deps;
    manager.registerType({
      id: 'eval',
      name: 'Eval',
      // WO-152: registry previously said 'Y' while the live panel's own
      // super() call used 'V' — a pre-existing registry/instance mismatch as
      // well as a collision ('Y' with communication/settings-sync, 'V' with
      // services). Unified to a single unique glyph in both places.
      icon: '▮',
      category: 'incidents-diagnostics',
      description: 'Evaluation harness: benchmark suite results, scorecards, and regression gates',
      factory: withUnconfiguredFallback(
        evalRegistry !== undefined,
        'eval', 'Eval', '▮', 'incidents-diagnostics',
        ' Eval registry not configured for this session.',
        'This runtime was not wired with an evaluation harness registry at bootstrap, so no eval data is available.',
        () => new EvalPanel(evalRegistry!, ui.environment.shellPaths.workingDirectory),
      ),
    });
  }
}
