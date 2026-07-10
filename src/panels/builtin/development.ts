import type { PanelManager } from '../panel-manager.ts';
import { GitPanel } from '../git-panel.ts';
import { DiffPanel } from '../diff-panel.ts';
import { DiffReviewPanel } from '../diff-review-panel.ts';
import { CostTrackerPanel } from '../cost-tracker-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';
import { requireUiServices, withUnconfiguredFallback } from './shared.ts';

// W6.1 (the purge): plan, intelligence, explorer, preview, and symbols were
// registered here before the purge. plan was RETIRE-INTO-FLEET (its
// execution-plan view is subsumed by Fleet — operations.ts:84); the other
// four were DELETE-disposition (no surviving human surface — intelligence's
// read-model still backs the surviving `/intelligence` CLI subcommands, see
// intelligence-runtime.ts; explorer/preview/symbols had no dedicated
// read-model to preserve). See .goodvibes/audit/2026-07-04-wave6-briefs.json
// (W6.1) for the full disposition map.
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

  // Compat: '/panel open plan' (and any saved layout/muscle memory) still
  // resolves — redirected to fleet, which absorbs the execution-plan view.
  manager.registerAlias('plan', 'fleet');

  manager.registerType({
    id: 'diff',
    name: 'Diff',
    icon: 'D',
    category: 'development',
    description: 'Unified diff view of agent file changes',
    factory: () => new DiffPanel(requireUiServices(deps).environment.workingDirectory, deps.requestRender),
  });

  manager.registerType({
    id: 'review',
    name: 'Review',
    icon: 'R',
    category: 'development',
    description: 'Comment on session diff hunks and steer the comments to the model',
    factory: () => new DiffReviewPanel(
      requireUiServices(deps).environment.workingDirectory,
      deps.requestRender,
      deps.sessionChangeTracker ? () => deps.sessionChangeTracker!.getChangedFiles() : undefined,
    ),
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
            configAccess: {
              get: (key) => deps.configManager.get(key as Parameters<typeof deps.configManager.get>[0]),
              set: (key, value) => deps.configManager.set(key as Parameters<typeof deps.configManager.set>[0], value as never),
            },
          });
        },
      ),
    });
  }
}
