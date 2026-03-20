import type { PanelManager } from './panel-manager.ts';
import { GitPanel } from './git-panel.ts';
import { DiffPanel } from './diff-panel.ts';
import { PlanDashboardPanel } from './plan-dashboard-panel.ts';
import { CostTrackerPanel } from './cost-tracker-panel.ts';
import { ProviderStatsPanel } from './provider-stats-panel.ts';
import { AgentInspectorPanel } from './agent-inspector-panel.ts';
import type { EventBus } from '../core/event-bus.ts';

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
  }
}
