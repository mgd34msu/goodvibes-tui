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
import type { EventBus } from '../core/event-bus.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import { EvalPanel, EvalRegistry } from './eval-panel.ts';
import { MemoryPanel } from './memory-panel.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import { SystemMessagesPanel } from './system-messages-panel.ts';

/**
 * Register all built-in panel types with the given PanelManager.
 *
 * Call this once during application startup, before opening any panels.
 */
export interface BuiltinPanelDeps {
  /** EventBus for panels that subscribe to application events. */
  bus?: EventBus;
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
  /** RuntimeEventBus for panels requiring typed domain events (e.g. ops-control). */
  runtimeBus?: RuntimeEventBus;
  /** ForensicsRegistry for the Forensics panel. */
  forensicsRegistry?: import('../runtime/forensics/registry.ts').ForensicsRegistry;
  /** EvalRegistry for the Eval panel. */
  evalRegistry?: EvalRegistry;
  /** MemoryRegistry for the Memory panel. */
  memoryRegistry?: MemoryRegistry;
}

export function registerBuiltinPanels(manager: PanelManager, deps: BuiltinPanelDeps = {}): void {
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

  if (deps.bus && deps.getOrchestratorUsage) {
    const { bus, getOrchestratorUsage, budgetThreshold } = deps;
    manager.registerType({
      id: 'cost',
      name: 'Cost',
      icon: '$',
      category: 'monitoring',
      description: 'Estimated costs per session, agent, and plan with budget alerts',
      factory: () => new CostTrackerPanel(bus, getOrchestratorUsage, { budgetThreshold }),
    });
  }

  if (deps.bus) {
    const { bus } = deps;
    manager.registerType({
      id: 'providers',
      name: 'Providers',
      icon: 'R',
      category: 'monitoring',
      description: 'Per-provider performance metrics: latency, error rate, request count, sparkline trends',
      factory: () => new ProviderStatsPanel(bus),
    });

    manager.registerType({
      id: 'thinking',
      name: 'Thinking',
      icon: 'T',
      category: 'ai',
      description: 'Stream model reasoning tokens in real-time with collapsible blocks per turn',
      factory: () => new ThinkingPanel(bus),
    });

    manager.registerType({
      id: 'tools',
      name: 'Tools',
      icon: 'X',
      category: 'ai',
      description: 'Chronological tool call inspector with expandable args/results and filtering',
      factory: () => new ToolInspectorPanel(bus),
    });

    manager.registerType({
      id: 'context',
      name: 'Context',
      icon: 'C',
      category: 'ai',
      description: 'Context window visualizer: stacked bar showing token usage per section',
      factory: () => new ContextVisualizerPanel(
        bus,
        deps.getOrchestratorUsage,
        deps.contextWindow,
      ),
    });
  }

  manager.registerType({
    id: 'sessions',
    name: 'Sessions',
    icon: 'H',
    category: 'session',
    description: 'Browse, search, and resume past conversation sessions',
    factory: () => new SessionBrowserPanel(deps.bus),
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

  if (deps.bus) {
    const { bus } = deps;

    manager.registerType({
      id: 'agent-logs',
      name: 'Agent Logs',
      icon: 'A',
      category: 'agent',
      description: 'Live log stream from all running agents',
      factory: () => new AgentLogsPanel(bus),
    });

    manager.registerType({
      id: 'wrfc',
      name: 'WRFC',
      icon: 'W',
      category: 'agent',
      description: 'WRFC chain view: write, review, fix, and confirm cycle status',
      factory: () => new WrfcPanel(bus),
    });
  }

  manager.registerType({
    id: 'schedule',
    name: 'Schedule',
    icon: 'Z',
    category: 'agent',
    description: 'Scheduled agent tasks: cron expressions, next run time, enable/disable, run history',
    factory: () => new SchedulePanel(),
  });

  if (deps.bus) {
    const { bus } = deps;
    manager.registerType({
      id: 'debug',
      name: 'Debug',
      icon: 'B',
      category: 'monitoring',
      description: 'API debug panel: per-call log with model, provider, tokens, latency, status, and error history',
      factory: () => {
        const panel = new DebugPanel(bus);
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
      factory: () => new ProviderHealthPanel(bus),
    });
  }

  if (deps.bus) {
    const { bus } = deps;
    manager.registerType({
      id: 'ops',
      name: 'Ops',
      icon: 'O',
      category: 'agent',
      description: 'Adaptive Execution Planner: strategy timeline, reason codes, mode and override controls',
      factory: () => new OpsStrategyPanel(bus),
    });
  }

  if (deps.runtimeBus) {
    const { runtimeBus } = deps;
    manager.registerType({
      id: 'ops-control',
      name: 'Ops Control',
      icon: 'Q',
      category: 'agent',
      description: 'Operator Control Plane: audit log of operator interventions (task/agent cancel, pause, resume, retry)',
      factory: () => new OpsControlPanel(runtimeBus),
    });
  }

  if (deps.forensicsRegistry) {
    const { forensicsRegistry } = deps;
    manager.registerType({
      id: 'forensics',
      name: 'Forensics',
      icon: 'F',
      category: 'monitoring',
      description: 'Failure Forensics: auto-classified failure reports with causal chains, phase timings, and jump links',
      factory: () => new ForensicsPanel(forensicsRegistry),
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
      id: 'memory',
      name: 'Memory',
      icon: 'M',
      category: 'agent',
      description: 'Project memory: decisions, constraints, incidents, and patterns with provenance links',
      factory: () => new MemoryPanel(memoryRegistry),
    });
  }

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
        panel.wire(deps.orchestrator, deps.getCtxWindow);
      }
      return panel;
    },
  });
}
