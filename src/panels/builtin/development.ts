import type { PanelManager } from '../panel-manager.ts';
import { GitPanel } from '../git-panel.ts';
import { DiffPanel } from '../diff-panel.ts';
import { PlanDashboardPanel } from '../plan-dashboard-panel.ts';
import { CostTrackerPanel } from '../cost-tracker-panel.ts';
import { IntelligencePanel } from '../intelligence-panel.ts';
import { FileExplorerPanel } from '../file-explorer-panel.ts';
import { FilePreviewPanel } from '../file-preview-panel.ts';
import { SymbolOutlinePanel } from '../symbol-outline-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices, withUnconfiguredFallback } from './shared.ts';

export function registerDevelopmentPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  manager.registerType({
    id: 'git',
    name: 'Git',
    icon: 'G',
    category: 'development',
    description: 'Git status, staged/unstaged changes, and recent commits',
    // sessionChangeTracker is optional: when a caller wires it into
    // BuiltinPanelDeps, the Git panel highlights files touched this session.
    factory: () => new GitPanel(
      requireUiServices(deps).environment.workingDirectory,
      deps.requestRender,
      deps.sessionChangeTracker ? () => deps.sessionChangeTracker!.getChangedFiles() : undefined,
    ),
  });

  manager.registerType({
    id: 'plan',
    name: 'Plan',
    // Distinct from Planning's 'P' (builtin/agent.ts) — interim glyph per
    // WO-128; WO-152 owns the registry-wide icon-uniqueness assertion.
    icon: '▤',
    category: 'agent',
    description: 'Active execution plan with phase progress and item status',
    factory: () => {
      const ui = requireUiServices(deps);
      return new PlanDashboardPanel(ui.events.workflows, { planManager: deps.planManager });
    },
  });

  manager.registerType({
    id: 'diff',
    name: 'Diff',
    icon: 'D',
    category: 'development',
    description: 'Unified diff view of agent file changes',
    factory: () => new DiffPanel(requireUiServices(deps).environment.workingDirectory),
  });

  // WO-110: 'inspector' registration moved to builtin/agent.ts (category
  // 'agent') — it now absorbs the merged agent-logs capabilities.

  // WO-152: always registered (was gated behind `if (deps.getOrchestratorUsage)`,
  // so `/panel open cost` reported "Unknown panel" on builds without usage
  // tracking wired). Falls back to a "dependency not configured" empty state.
  {
    const { getOrchestratorUsage, budgetThreshold } = deps;
    manager.registerType({
      id: 'cost',
      name: 'Cost',
      icon: '$',
      category: 'providers',
      description: 'Estimated costs per session, agent, and plan with budget alerts',
      factory: withUnconfiguredFallback(
        getOrchestratorUsage !== undefined,
        'cost', 'Cost', '$', 'providers',
        ' Cost tracking not configured for this session.',
        'This runtime was not wired with orchestrator usage tracking at bootstrap, so no cost data is available.',
        () => {
          const ui = requireUiServices(deps);
          return new CostTrackerPanel(ui.events.turns, ui.events.agents, getOrchestratorUsage!, {
            budgetThreshold,
            getAgentStatus: (id) => ui.agents.agentManager.getStatus(id),
          });
        },
      ),
    });
  }

  manager.registerType({
    id: 'intelligence',
    name: 'Intelligence',
    icon: 'J',
    category: 'development',
    description: 'Workspace diagnostics, symbol search, hover, and completion readiness with recovery guidance',
    factory: () => new IntelligencePanel(requireUiServices(deps).readModels.intelligence),
  });

  manager.registerType({
    id: 'explorer',
    name: 'Explorer',
    icon: 'E',
    category: 'development',
    description: 'File system browser with keyboard navigation',
    factory: () => {
        const ui = requireUiServices(deps);
        return new FileExplorerPanel(ui.environment.workingDirectory, ui.environment.workingDirectory);
      },
    });

  manager.registerType({
    id: 'preview',
    name: 'Preview',
    // WO-152: was 'V' in the registry vs the live panel's own 'P' (base-panel
    // super() call) — a pre-existing registry/instance icon mismatch as well
    // as a collision (project-planning and plugins both also used 'P').
    // Unified to a single unique glyph in both places.
    icon: '◑',
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
