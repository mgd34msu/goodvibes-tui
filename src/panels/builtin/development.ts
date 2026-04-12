import type { PanelManager } from '../panel-manager.ts';
import { GitPanel } from '../git-panel.ts';
import { DiffPanel } from '../diff-panel.ts';
import { PlanDashboardPanel } from '../plan-dashboard-panel.ts';
import { AgentInspectorPanel } from '../agent-inspector-panel.ts';
import { CostTrackerPanel } from '../cost-tracker-panel.ts';
import { IntelligencePanel } from '../intelligence-panel.ts';
import { FileExplorerPanel } from '../file-explorer-panel.ts';
import { FilePreviewPanel } from '../file-preview-panel.ts';
import { SymbolOutlinePanel } from '../symbol-outline-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices } from './shared.ts';

export function registerDevelopmentPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
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
    factory: () => new PlanDashboardPanel(deps.planManager),
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
    factory: () => {
      const ui = requireUiServices(deps);
      return new AgentInspectorPanel({
        agentManager: ui.agentManager,
        agentMessageBus: ui.agentMessageBus,
      });
    },
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

  manager.registerType({
    id: 'intelligence',
    name: 'Intelligence',
    icon: 'J',
    category: 'development',
    description: 'Workspace diagnostics, symbol search, hover, and completion readiness with recovery guidance',
    factory: () => new IntelligencePanel(deps.runtimeStore),
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
}
