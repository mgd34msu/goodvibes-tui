import type { PanelManager } from '../panel-manager.ts';
import { CockpitPanel } from '../cockpit-panel.ts';
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
import { requireAutomationManager, requireControlPlanePanelDeps, requireHookPanelDeps, requirePluginManager, requireUiServices } from './shared.ts';
import { createCockpitRosterReadModel } from '../cockpit-read-model.ts';

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

  manager.registerType({
    id: 'cockpit',
    name: 'Cockpit',
    icon: 'O',
    category: 'monitoring',
    description: 'Unified operator summary for orchestration, permissions, communication, MCP, plugins, and integrations',
    factory: () => new CockpitPanel(
      ui.readModels.cockpit,
      rosterReadModel,
      {
        openAgentDetail: (agentId: string) => deps.openAgentDetail?.(agentId),
        cancelAgent: (agentId: string) => ui.agents.agentManager.cancel(agentId),
      },
    ),
  });

  manager.registerType({
    id: 'approval',
    name: 'Approval',
    icon: 'A',
    category: 'monitoring',
    description: 'Action-specific approval workspace for why-prompted, why-denied, and what-if review',
    factory: () => new ApprovalPanel(deps.policyRuntimeState),
  });

  manager.registerType({
    id: 'plugins',
    name: 'Plugins',
    icon: 'P',
    category: 'monitoring',
    description: 'Plugin trust, quarantine, capability, and activation status',
    factory: () => new PluginsPanel(requirePluginManager(deps)),
  });

  manager.registerType({
    id: 'skills',
    name: 'Skills',
    icon: 'K',
    category: 'monitoring',
    description: 'Project-local and global skill discovery with origin and dependency details',
    factory: () => new SkillsPanel({
      componentHealthMonitor: deps.componentHealthMonitor,
      shellPaths: ui.environment.shellPaths,
    }),
  });

  manager.registerType({
    id: 'services',
    name: 'Services',
    icon: 'V',
    category: 'monitoring',
    description: 'Configured external services, credential presence, and connection health tests',
    factory: () => new ServicesPanel(deps.serviceRegistry, deps.subscriptionManager),
  });

  manager.registerType({
    id: 'automation',
    name: 'Automation',
    icon: 'M',
    category: 'monitoring',
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
    category: 'monitoring',
    description: 'Cross-surface route bindings and shared session attachment state',
    factory: () => new RoutesPanel(ui.readModels.routes),
  });

  manager.registerType({
    id: 'control-plane',
    name: 'Control Plane',
    icon: 'C',
    category: 'monitoring',
    description: 'Daemon control-plane state, clients, approvals, and recent operator activity',
    factory: () => new ControlPlanePanel(ui.readModels.controlPlane, requireControlPlanePanelDeps(deps)),
  });

  manager.registerType({
    id: 'subscription',
    name: 'Subscriptions',
    icon: 'B',
    category: 'monitoring',
    description: 'OAuth-backed provider subscriptions and supported provider override posture',
    factory: () => new SubscriptionPanel(deps.serviceRegistry, deps.subscriptionManager),
  });

  manager.registerType({
    id: 'local-auth',
    name: 'Local Auth',
    icon: 'U',
    category: 'monitoring',
    description: 'Local daemon/listener auth users, bootstrap posture, and active sessions',
    factory: () => new LocalAuthPanel(deps.localUserAuthManager),
  });

  manager.registerType({
    id: 'settings-sync',
    name: 'Settings Sync',
    icon: 'Y',
    category: 'monitoring',
    description: 'Local, synced, and managed settings posture with recent sync events and active locks',
    factory: () => new SettingsSyncPanel(deps.configManager),
  });

  manager.registerType({
    id: 'worktrees',
    name: 'Worktrees',
    icon: 'W',
    category: 'monitoring',
    description: 'Orchestrator-owned git worktree lifecycle, attachments, and cleanup state',
    factory: () => new WorktreePanel(deps.worktreeRegistry),
  });

  manager.registerType({
    id: 'hooks',
    name: 'Hooks',
    icon: 'H',
    category: 'monitoring',
    description: 'Registered hooks, chains, contracts, and execution policy details',
    factory: () => {
      const hookDeps = requireHookPanelDeps(deps);
      return new HooksPanel(hookDeps.hookDispatcher, hookDeps.hookWorkbench, hookDeps.hookActivityTracker);
    },
  });

  manager.registerType({
    id: 'security',
    name: 'Security',
    icon: 'U',
    category: 'monitoring',
    description: 'Security review workspace for token audit, policy posture, MCP quarantine, and incident pressure',
    factory: () => new SecurityPanel(ui.readModels.security),
  });

  manager.registerType({
    id: 'marketplace',
    name: 'Marketplace',
    icon: 'M',
    category: 'monitoring',
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
    icon: 'X',
    category: 'monitoring',
    description: 'VM isolation posture for MCP servers and evaluation runtimes',
    factory: () => new SandboxPanel(deps.configManager, deps.sandboxSessionRegistry),
  });

  manager.registerType({
    id: 'tasks',
    name: 'Tasks',
    icon: 'J',
    category: 'monitoring',
    description: 'Queued, running, blocked, failed, and completed task summaries from the runtime store',
    factory: () => new TasksPanel(ui.readModels.tasks, ui.readModels.worktrees),
  });

  manager.registerType({
    id: 'orchestration',
    name: 'Orchestration',
    icon: 'Q',
    category: 'monitoring',
    description: 'Task-graph status, node roles, and bounded recursion guard activity',
    factory: () => new OrchestrationPanel(ui.readModels.orchestration),
  });

  manager.registerType({
    id: 'ops',
    name: 'Ops',
    icon: 'O',
    category: 'monitoring',
    description: 'Adaptive planner strategy timeline, override posture, and recent execution-mode decisions',
    factory: () => new OpsStrategyPanel(ui.events.planner, deps.adaptivePlanner),
  });

  manager.registerType({
    id: 'communication',
    name: 'Communication',
    icon: 'Y',
    category: 'monitoring',
    description: 'Structured agent communication, blocked routes, and delivery status',
    preload: true,
    factory: () => new CommunicationPanel(ui.readModels.communication),
  });

  manager.registerType({
    id: 'remote',
    name: 'Remote',
    icon: 'R',
    category: 'monitoring',
    description: 'Self-hosted daemon and ACP transport state with active remote connections',
    factory: () => new RemotePanel(ui.readModels.remote),
  });

  manager.registerType({
    id: 'provider-health',
    name: 'Health',
    icon: 'N',
    category: 'monitoring',
    description: 'Provider console: status, latency timelines, error attribution, auth routes, fallback chain, and repair actions',
    preload: true,
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
    icon: 'B',
    category: 'monitoring',
    description: 'API debug panel: per-call log with model, provider, tokens, latency, status, and error history',
    factory: () => {
      const panel = new DebugPanel(ui.events.turns, deps.requestRender);
      if (deps.orchestrator) panel.wireOrchestrator(deps.orchestrator);
      return panel;
    },
  });

  if (deps.forensicsRegistry) {
    const { forensicsRegistry } = deps;
    const incidentFactory = () => new IncidentReviewPanel(forensicsRegistry);
    manager.registerType({
      id: 'incident',
      name: 'Incident',
      icon: 'N',
      category: 'monitoring',
      description: 'Incident workspace with root cause, permission, budget, replay, causal-chain, phase-timing, and jump-link evidence',
      factory: incidentFactory,
    });
    // WO-114 compat (Forensics merged into Incident): the retired 'forensics'
    // panel id still resolves — redirected to the merged Incident workspace so
    // pre-existing openForensicsPanel()/`/forensics` callers land on the same
    // Incident instance instead of stacking a duplicate registration.
    manager.registerAlias('forensics', 'incident');
  }

  manager.registerType({
    id: 'policy',
    name: 'Policy',
    icon: 'U',
    category: 'monitoring',
    description: 'Policy governance: active/candidate bundles, divergence gate, rollout history, and simulation evidence',
    factory: () => new PolicyPanel(deps.policyRuntimeState),
  });

  if (deps.evalRegistry) {
    const { evalRegistry } = deps;
    manager.registerType({
      id: 'eval',
      name: 'Eval',
      icon: 'Y',
      category: 'monitoring',
      description: 'Evaluation harness: benchmark suite results, scorecards, and regression gates',
      factory: () => new EvalPanel(evalRegistry),
    });
  }
}
