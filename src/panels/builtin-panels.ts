import type { PanelManager } from './panel-manager.ts';
import { GitPanel } from './git-panel.ts';
import { DiffPanel } from './diff-panel.ts';
import { PlanDashboardPanel } from './plan-dashboard-panel.ts';
import { CostTrackerPanel } from './cost-tracker-panel.ts';
import { ProviderStatsPanel } from './provider-stats-panel.ts';
import { AgentInspectorPanel } from './agent-inspector-panel.ts';
import { SessionBrowserPanel } from './session-browser-panel.ts';
import { DocsPanel } from './docs-panel.ts';
import { ThinkingPanel } from './thinking-panel.ts';
import { ToolInspectorPanel } from './tool-inspector-panel.ts';
import { ContextVisualizerPanel } from './context-visualizer-panel.ts';
import { FileExplorerPanel } from './file-explorer-panel.ts';
import { FilePreviewPanel } from './file-preview-panel.ts';
import { SymbolOutlinePanel } from './symbol-outline-panel.ts';
import { AgentLogsPanel } from './agent-logs-panel.ts';
import { TokenBudgetPanel } from './token-budget-panel.ts';
import { WrfcPanel } from './wrfc-panel.ts';
import { SchedulePanel } from './schedule-panel.ts';
import { ProviderHealthPanel } from './provider-health-panel.ts';
import { DebugPanel } from './debug-panel.ts';
import { OpsStrategyPanel } from './ops-strategy-panel.ts';
import { OpsControlPanel } from './ops-control-panel.ts';
import { ForensicsPanel } from './forensics-panel.ts';
import { IncidentReviewPanel } from './incident-review-panel.ts';
import { PolicyPanel } from './policy-panel.ts';
import { PluginsPanel } from './plugins-panel.ts';
import { SkillsPanel } from './skills-panel.ts';
import { TasksPanel } from './tasks-panel.ts';
import { OrchestrationPanel } from './orchestration-panel.ts';
import { CommunicationPanel } from './communication-panel.ts';
import { CockpitPanel } from './cockpit-panel.ts';
import { ServicesPanel } from './services-panel.ts';
import { McpPanel } from './mcp-panel.ts';
import { HooksPanel } from './hooks-panel.ts';
import { SecurityPanel } from './security-panel.ts';
import { RemotePanel } from './remote-panel.ts';
import { MarketplacePanel } from './marketplace-panel.ts';
import { SandboxPanel } from './sandbox-panel.ts';
import { ApprovalPanel } from './approval-panel.ts';
import { WelcomePanel } from './welcome-panel.ts';
import { SubscriptionPanel } from './subscription-panel.ts';
import { SettingsSyncPanel } from './settings-sync-panel.ts';
import { WorktreePanel } from './worktree-panel.ts';
import { ProviderAccountsPanel } from './provider-accounts-panel.ts';
import { LocalAuthPanel } from './local-auth-panel.ts';
import { IntelligencePanel } from './intelligence-panel.ts';
import type { ConfigManager } from '../config/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import { EvalPanel, EvalRegistry } from './eval-panel.ts';
import { MemoryPanel } from './memory-panel.ts';
import { KnowledgePanel } from './knowledge-panel.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import { SystemMessagesPanel } from './system-messages-panel.ts';
import { PanelListPanel } from './panel-list-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { ApiTokenAuditor } from '../security/token-audit.ts';

/**
 * Register all built-in panel types with the given PanelManager.
 *
 * Call this once during application startup, before opening any panels.
 */
export interface BuiltinPanelDeps {
  /** Config manager for settings-sync and other config-backed panels. */
  configManager?: ConfigManager;
  /** Getter returning the main orchestrator's cumulative token usage. */
  getOrchestratorUsage?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string };
  /** Optional cost budget alert threshold in USD (0 = disabled). */
  budgetThreshold?: number;
  /** Tool registry for Docs panel. */
  toolRegistry?: ToolRegistry;
  /** Provider registry for Docs panel model list. */
  providerRegistry?: ProviderRegistry;
  /** Context window size in tokens (for ContextVisualizerPanel). */
  contextWindow?: number;
  /** Main Orchestrator instance for TokenBudgetPanel.wire(). */
  orchestrator?: Orchestrator;
  /** Callback returning the current model context window size (for TokenBudgetPanel). */
  getCtxWindow?: () => number;
  /** Resume a saved session directly through the session controller path. */
  resumeSession?: (sessionId: string) => void;
  /** Request a shell repaint directly rather than routing through a retired event path. */
  requestRender?: () => void;
  /** RuntimeEventBus for typed panel subscriptions and operator surfaces. */
  runtimeBus: RuntimeEventBus;
  /** ForensicsRegistry for the Forensics panel. */
  forensicsRegistry?: import('../runtime/forensics/registry.ts').ForensicsRegistry;
  /** EvalRegistry for the Eval panel. */
  evalRegistry?: EvalRegistry;
  /** MemoryRegistry for the Memory panel. */
  memoryRegistry?: MemoryRegistry;
  /** Shared policy runtime state for governance/policy diagnostics. */
  policyRuntimeState?: import('../runtime/permissions/policy-runtime.ts').PolicyRuntimeState;
  /** Runtime store for store-backed control-room panels. */
  runtimeStore?: RuntimeStore;
  /** Token auditor for the security control-room panel. */
  tokenAuditor?: ApiTokenAuditor;
}

export function registerBuiltinPanels(manager: PanelManager, deps: BuiltinPanelDeps): void {
  manager.registerType({
    id: 'git',
    name: 'Git',
    icon: 'G',
    category: 'development',
    description: 'Git status, staged/unstaged changes, and recent commits',
    factory: () => new GitPanel(),
  });

  manager.registerType({
    id: 'plan',
    name: 'Plan',
    icon: 'P',
    category: 'agent',
    description: 'Active execution plan with phase progress and item status',
    factory: () => new PlanDashboardPanel(),
  });

  manager.registerType({
    id: 'diff',
    name: 'Diff',
    icon: 'D',
    category: 'development',
    description: 'Unified diff view of agent file changes',
    factory: () => new DiffPanel(),
  });

  manager.registerType({
    id: 'inspector',
    name: 'Inspector',
    icon: 'I',
    category: 'agent',
    description: "Detailed timeline view of a specific agent's messages and tool calls",
    factory: () => new AgentInspectorPanel(),
  });

  if (deps.getOrchestratorUsage) {
    const { getOrchestratorUsage, budgetThreshold, runtimeBus } = deps;
    manager.registerType({
      id: 'cost',
      name: 'Cost',
      icon: '$',
      category: 'monitoring',
      description: 'Estimated costs per session, agent, and plan with budget alerts',
      factory: () => new CostTrackerPanel(runtimeBus, getOrchestratorUsage, { budgetThreshold }),
    });
  }

  const { runtimeBus } = deps;
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
    factory: () => new ApprovalPanel(),
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
    factory: () => new PluginsPanel(),
  });

  manager.registerType({
    id: 'skills',
    name: 'Skills',
    icon: 'K',
    category: 'monitoring',
    description: 'Project-local and global skill discovery with origin and dependency details',
    factory: () => new SkillsPanel(),
  });

  manager.registerType({
    id: 'services',
    name: 'Services',
    icon: 'V',
    category: 'monitoring',
    description: 'Configured external services, credential presence, and connection health tests',
    factory: () => new ServicesPanel(),
  });

  manager.registerType({
    id: 'subscription',
    name: 'Subscriptions',
    icon: 'B',
    category: 'monitoring',
    description: 'OAuth-backed provider subscriptions and supported provider override posture',
    factory: () => new SubscriptionPanel(),
  });

  manager.registerType({
    id: 'local-auth',
    name: 'Local Auth',
    icon: 'U',
    category: 'monitoring',
    description: 'Local daemon/listener auth users, bootstrap posture, and active sessions',
    factory: () => new LocalAuthPanel(),
  });

  manager.registerType({
    id: 'accounts',
    name: 'Accounts',
    icon: 'Q',
    category: 'monitoring',
    description: 'Provider auth routes, subscription quota-window hints, and billing-path safety notes',
    factory: () => new ProviderAccountsPanel(),
  });

  manager.registerType({
    id: 'settings-sync',
    name: 'Settings Sync',
    icon: 'Y',
    category: 'monitoring',
    description: 'Local, synced, and managed settings posture with recent sync events and active locks',
    factory: () => new SettingsSyncPanel(deps.configManager as ConfigManager),
  });

  manager.registerType({
    id: 'intelligence',
    name: 'Intelligence',
    icon: 'J',
    category: 'development',
    description: 'Workspace diagnostics, symbol search, hover, and completion readiness with recovery guidance',
    factory: () => new IntelligencePanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'worktrees',
    name: 'Worktrees',
    icon: 'W',
    category: 'monitoring',
    description: 'Orchestrator-owned git worktree lifecycle, attachments, and cleanup state',
    factory: () => new WorktreePanel(),
  });

  manager.registerType({
    id: 'mcp',
    name: 'MCP',
    icon: 'Z',
    category: 'monitoring',
    description: 'MCP trust, role, path scope, host scope, and connection status',
    factory: () => new McpPanel(),
  });

  manager.registerType({
    id: 'hooks',
    name: 'Hooks',
    icon: 'H',
    category: 'monitoring',
    description: 'Registered hooks, chains, contracts, and execution policy details',
    factory: () => new HooksPanel(),
  });

  manager.registerType({
    id: 'security',
    name: 'Security',
    icon: 'U',
    category: 'monitoring',
    description: 'Security review workspace for token audit, policy posture, MCP quarantine, and incident pressure',
    factory: () => new SecurityPanel(
      deps.tokenAuditor,
      deps.policyRuntimeState,
      deps.runtimeStore,
      deps.forensicsRegistry,
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
    factory: () => new SandboxPanel(),
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
    factory: () => new RemotePanel(deps.runtimeStore),
  });

  manager.registerType({
    id: 'providers',
    name: 'Providers',
    icon: 'R',
    category: 'monitoring',
    description: 'Per-provider performance metrics: latency, error rate, request count, sparkline trends',
    factory: () => new ProviderStatsPanel(runtimeBus, deps.requestRender),
  });

  manager.registerType({
    id: 'thinking',
    name: 'Thinking',
    icon: 'T',
    category: 'ai',
    description: 'Stream model reasoning tokens in real-time with collapsible blocks per turn',
    factory: () => new ThinkingPanel(runtimeBus),
  });

  manager.registerType({
    id: 'tools',
    name: 'Tools',
    icon: 'X',
    category: 'ai',
    description: 'Chronological tool call inspector with expandable args/results and filtering',
    factory: () => new ToolInspectorPanel(runtimeBus),
  });

  manager.registerType({
    id: 'context',
    name: 'Context',
    icon: 'C',
    category: 'ai',
    description: 'Context window visualizer: stacked bar showing token usage per section',
    factory: () => new ContextVisualizerPanel(
      runtimeBus,
      deps.getOrchestratorUsage,
      deps.contextWindow,
      deps.runtimeStore,
    ),
  });

  manager.registerType({
    id: 'sessions',
    name: 'Sessions',
    icon: 'H',
    category: 'session',
    description: 'Browse, search, and resume past conversation sessions',
    factory: () => new SessionBrowserPanel(deps.resumeSession),
  });

  manager.registerType({
    id: 'docs',
    name: 'Docs',
    icon: '?',
    category: 'session',
    description: 'Tool list, model capabilities, and keyboard shortcut reference',
    factory: () => new DocsPanel(deps.toolRegistry, deps.providerRegistry),
  });

  manager.registerType({
    id: 'explorer',
    name: 'Explorer',
    icon: 'E',
    category: 'development',
    description: 'File system browser with keyboard navigation',
    factory: () => new FileExplorerPanel(),
  });

  manager.registerType({
    id: 'preview',
    name: 'Preview',
    icon: 'V',
    category: 'development',
    description: 'Syntax-highlighted file preview',
    factory: () => new FilePreviewPanel(),
  });

  manager.registerType({
    id: 'symbols',
    name: 'Symbols',
    icon: 'S',
    category: 'development',
    description: 'Symbol outline for the active file: functions, classes, and exports',
    factory: () => new SymbolOutlinePanel(),
  });

  manager.registerType({
    id: 'agent-logs',
    name: 'Agent Logs',
    icon: 'A',
    category: 'agent',
    description: 'Live log stream from all running agents',
    factory: () => new AgentLogsPanel(runtimeBus),
  });

  manager.registerType({
    id: 'wrfc',
    name: 'WRFC',
    icon: 'W',
    category: 'agent',
    description: 'WRFC chain view: write, review, fix, and confirm cycle status',
    factory: () => new WrfcPanel(runtimeBus),
  });

  manager.registerType({
    id: 'schedule',
    name: 'Schedule',
    icon: 'Z',
    category: 'agent',
    description: 'Scheduled agent tasks: cron expressions, next run time, enable/disable, run history',
    factory: () => new SchedulePanel(),
  });

  manager.registerType({
    id: 'debug',
    name: 'Debug',
    icon: 'B',
    category: 'monitoring',
    description: 'API debug panel: per-call log with model, provider, tokens, latency, status, and error history',
    factory: () => {
      const panel = new DebugPanel(runtimeBus, deps.requestRender);
      if (deps.orchestrator) panel.wireOrchestrator(deps.orchestrator);
      return panel;
    },
  });

  manager.registerType({
    id: 'provider-health',
    name: 'Health',
    icon: 'N',
    category: 'monitoring',
    description: 'Provider health dashboard: real-time status, latency, errors, and rate-limit cooldowns',
    factory: () => new ProviderHealthPanel(runtimeBus, deps.requestRender, deps.runtimeStore, deps.configManager),
  });

  manager.registerType({
    id: 'ops',
    name: 'Ops',
    icon: 'O',
    category: 'agent',
    description: 'Adaptive Execution Planner: strategy timeline, reason codes, mode and override controls',
    factory: () => new OpsStrategyPanel(runtimeBus),
  });

  manager.registerType({
    id: 'ops-control',
    name: 'Ops Control',
    icon: 'Q',
    category: 'agent',
    description: 'Operator Control Plane: audit log of operator interventions (task/agent cancel, pause, resume, retry)',
    factory: () => new OpsControlPanel(runtimeBus),
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

  if (deps.policyRuntimeState) {
    const { policyRuntimeState } = deps;
    manager.registerType({
      id: 'policy',
      name: 'Policy',
      icon: 'U',
      category: 'monitoring',
      description: 'Policy governance: active/candidate bundles, divergence gate, rollout history, and simulation evidence',
      factory: () => new PolicyPanel(policyRuntimeState),
    });
  }

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

  if (deps.memoryRegistry) {
    const { memoryRegistry } = deps;
    manager.registerType({
      id: 'knowledge',
      name: 'Knowledge',
      icon: 'K',
      category: 'agent',
      description: 'Structured project knowledge: risks, runbooks, architecture notes, incidents, and durable facts',
      factory: () => new KnowledgePanel(memoryRegistry),
    });
    manager.registerType({
      id: 'memory',
      name: 'Memory',
      icon: 'M',
      category: 'agent',
      description: 'Project memory: decisions, constraints, incidents, and patterns with provenance links',
      factory: () => new MemoryPanel(memoryRegistry),
    });
  }

  manager.registerType({
    id: 'panel-list',
    name: 'Panel List',
    icon: 'L',
    category: 'session',
    description: 'Browse all registered panels grouped by category, with open/closed status and Enter-to-open',
    factory: () => new PanelListPanel(),
  });

  manager.registerType({
    id: 'system-messages',
    name: 'System Messages',
    icon: 'J',
    category: 'monitoring',
    description: 'Operational system messages routed away from the main conversation (scans, discovery, plugin events, tool status)',
    factory: () => new SystemMessagesPanel(),
  });

  manager.registerType({
    id: 'tokens',
    name: 'Tokens',
    icon: 'K',
    category: 'monitoring',
    description: 'Token budget tracker: per-turn and cumulative usage with context window gauge',
    factory: () => {
      const panel = new TokenBudgetPanel();
      if (deps.orchestrator && deps.getCtxWindow) {
        panel.wire(deps.orchestrator, deps.getCtxWindow, deps.runtimeStore);
      }
      return panel;
    },
  });
}
