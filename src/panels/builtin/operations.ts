import type { PanelManager } from '../panel-manager.ts';
import { CockpitPanel } from '../cockpit-panel.ts';
import { ApprovalPanel } from '../approval-panel.ts';
import { WelcomePanel } from '../welcome-panel.ts';
import { PluginsPanel } from '../plugins-panel.ts';
import { SkillsPanel } from '../skills-panel.ts';
import { ServicesPanel } from '../services-panel.ts';
import { AutomationControlPanel } from '../automation-control-panel.ts';
import { RoutesPanel } from '../routes-panel.ts';
import { WatchersPanel } from '../watchers-panel.ts';
import { ControlPlanePanel } from '../control-plane-panel.ts';
import { SubscriptionPanel } from '../subscription-panel.ts';
import { LocalAuthPanel } from '../local-auth-panel.ts';
import { ProviderAccountsPanel } from '../provider-accounts-panel.ts';
import { SettingsSyncPanel } from '../settings-sync-panel.ts';
import { WorktreePanel } from '../worktree-panel.ts';
import { McpPanel } from '../mcp-panel.ts';
import { HooksPanel } from '../hooks-panel.ts';
import { SecurityPanel } from '../security-panel.ts';
import { MarketplacePanel } from '../marketplace-panel.ts';
import { SandboxPanel } from '../sandbox-panel.ts';
import { TasksPanel } from '../tasks-panel.ts';
import { OrchestrationPanel } from '../orchestration-panel.ts';
import { OpsStrategyPanel } from '../ops-strategy-panel.ts';
import { CommunicationPanel } from '../communication-panel.ts';
import { RemotePanel } from '../remote-panel.ts';
import { ProviderStatsPanel } from '../provider-stats-panel.ts';
import { ProviderHealthPanel } from '../provider-health-panel.ts';
import { DebugPanel } from '../debug-panel.ts';
import { IncidentReviewPanel } from '../incident-review-panel.ts';
import { ForensicsPanel } from '../forensics-panel.ts';
import { PolicyPanel } from '../policy-panel.ts';
import { EvalPanel } from '../eval-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireAutomationManager, requireControlPlanePanelDeps, requireHookPanelDeps, requireMcpRegistry, requirePluginManager, requireUiServices } from './shared.ts';

export function registerOperationsPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'cockpit',
    name: 'Cockpit',
    icon: 'O',
    category: 'monitoring',
    description: 'Unified operator summary for orchestration, permissions, communication, MCP, plugins, and integrations',
    factory: () => new CockpitPanel(
      deps.runtimeStore,
      deps.policyRuntimeState,
      deps.forensicsRegistry,
      deps.tokenAuditor,
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
    id: 'welcome',
    name: 'Welcome',
    icon: 'W',
    category: 'monitoring',
    description: 'Guided start surface for setup, security, marketplace, remote, and operator workflows',
    factory: () => new WelcomePanel(),
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
    factory: () => new SkillsPanel({ panelHealthMonitor: deps.panelHealthMonitor }),
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
    description: 'Automation jobs, runs, deliveries, and failure posture across the control plane',
    factory: () => new AutomationControlPanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'routes',
    name: 'Routes',
    icon: 'R',
    category: 'monitoring',
    description: 'Cross-surface route bindings and shared session attachment state',
    factory: () => new RoutesPanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'watchers',
    name: 'Watchers',
    icon: 'W',
    category: 'monitoring',
    description: 'Watcher health, lag, and degraded source state for automation inputs',
    factory: () => new WatchersPanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'control-plane',
    name: 'Control Plane',
    icon: 'C',
    category: 'monitoring',
    description: 'Daemon control-plane state, clients, approvals, and recent operator activity',
    factory: () => {
      const controlPlaneDeps = requireControlPlanePanelDeps(deps);
      return new ControlPlanePanel(deps.runtimeStore, {
        approvalBroker: controlPlaneDeps.approvalBroker,
        sessionBroker: controlPlaneDeps.sessionBroker,
        getRecentEvents: controlPlaneDeps.getControlPlaneRecentEvents,
      });
    },
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
    id: 'accounts',
    name: 'Accounts',
    icon: 'Q',
    category: 'monitoring',
    description: 'Provider auth routes, subscription quota-window hints, and billing-path safety notes',
    factory: () => new ProviderAccountsPanel({
      providerRegistry: deps.providerRegistry,
      serviceRegistry: deps.serviceRegistry,
      subscriptionManager: deps.subscriptionManager,
    }),
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
    id: 'mcp',
    name: 'MCP',
    icon: 'Z',
    category: 'monitoring',
    description: 'MCP trust, role, path scope, host scope, and connection status',
    factory: () => new McpPanel(requireMcpRegistry(deps)),
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
    factory: () => new SecurityPanel(
      requirePluginManager(deps),
      deps.tokenAuditor,
      deps.policyRuntimeState,
      deps.runtimeStore,
      deps.forensicsRegistry,
      requireMcpRegistry(deps),
    ),
  });

  manager.registerType({
    id: 'marketplace',
    name: 'Marketplace',
    icon: 'M',
    category: 'monitoring',
    description: 'Curated plugin and skill marketplace with provenance, compatibility, and install posture',
    factory: () => new MarketplacePanel(deps.runtimeStore),
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
    factory: () => new TasksPanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'orchestration',
    name: 'Orchestration',
    icon: 'Q',
    category: 'monitoring',
    description: 'Task-graph status, node roles, and bounded recursion guard activity',
    factory: () => new OrchestrationPanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'ops',
    name: 'Ops',
    icon: 'O',
    category: 'monitoring',
    description: 'Adaptive planner strategy timeline, override posture, and recent execution-mode decisions',
    factory: () => new OpsStrategyPanel(deps.runtimeBus, deps.adaptivePlanner),
  });

  manager.registerType({
    id: 'communication',
    name: 'Communication',
    icon: 'Y',
    category: 'monitoring',
    description: 'Structured agent communication, blocked routes, and delivery status',
    factory: () => new CommunicationPanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'remote',
    name: 'Remote',
    icon: 'R',
    category: 'monitoring',
    description: 'Self-hosted daemon and ACP transport state with active remote connections',
    factory: () => {
      const ui = requireUiServices(deps);
      return new RemotePanel(deps.runtimeStore, {
        distributedRuntime: ui.distributedRuntime,
        remoteRunnerRegistry: ui.remoteRunnerRegistry,
        remoteSupervisor: ui.remoteSupervisor,
      });
    },
  });

  manager.registerType({
    id: 'providers',
    name: 'Providers',
    icon: 'R',
    category: 'monitoring',
    description: 'Per-provider performance metrics: latency, error rate, request count, sparkline trends',
    factory: () => new ProviderStatsPanel(deps.runtimeBus, deps.requestRender, deps.providerRegistry),
  });

  manager.registerType({
    id: 'provider-health',
    name: 'Health',
    icon: 'N',
    category: 'monitoring',
    description: 'Provider health dashboard: real-time status, latency, errors, and rate-limit cooldowns',
    factory: () => new ProviderHealthPanel(
      deps.runtimeBus,
      deps.providerRegistry,
      deps.localUserAuthManager,
      deps.serviceRegistry,
      deps.subscriptionManager,
      deps.requestRender,
      deps.runtimeStore,
      deps.configManager,
      deps.uiServices?.remoteSupervisor,
    ),
  });

  manager.registerType({
    id: 'debug',
    name: 'Debug',
    icon: 'B',
    category: 'monitoring',
    description: 'API debug panel: per-call log with model, provider, tokens, latency, status, and error history',
    factory: () => {
      const panel = new DebugPanel(deps.runtimeBus, deps.requestRender);
      if (deps.orchestrator) panel.wireOrchestrator(deps.orchestrator);
      return panel;
    },
  });

  if (deps.forensicsRegistry) {
    const { forensicsRegistry } = deps;
    manager.registerType({
      id: 'incident',
      name: 'Incident',
      icon: 'N',
      category: 'monitoring',
      description: 'Incident workspace with root cause, permission, budget, and replay evidence',
      factory: () => new IncidentReviewPanel(forensicsRegistry),
    });
    manager.registerType({
      id: 'forensics',
      name: 'Forensics',
      icon: 'F',
      category: 'monitoring',
      description: 'Failure Forensics: auto-classified failure reports with causal chains, phase timings, and jump links',
      factory: () => new ForensicsPanel(forensicsRegistry),
    });
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
