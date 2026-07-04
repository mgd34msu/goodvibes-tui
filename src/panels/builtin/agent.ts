import type { PanelManager } from '../panel-manager.ts';
import { ProjectPlanningPanel } from '../project-planning-panel.ts';
import { WorkPlanPanel } from '../work-plan-panel.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';

// W6.1 (the purge): thinking, tools, inspector, and wrfc were registered here
// before the purge. thinking/tools were DELETE-disposition (no surviving
// human surface — thinking already renders inline in the transcript, tool
// results render inline plus per-node in Fleet); inspector/wrfc were
// RETIRE-INTO-FLEET (their live console is subsumed by the Fleet panel,
// operations.ts:84). See registerOperationsPanels for the fleet
// registration and .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1) for
// the full disposition map.
export function registerAgentPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  // Compat: '/panel open agent-logs' and 'inspector' (and any saved
  // layout/muscle memory) still resolve — redirected straight to fleet.
  // Repointed from agent-logs->inspector (WO-110) now that inspector itself
  // is retired; alias resolution is a single hop (PanelManager._resolveId),
  // so this must point at the real surviving id, not at another alias.
  manager.registerAlias('agent-logs', 'fleet');
  manager.registerAlias('inspector', 'fleet');
  manager.registerAlias('wrfc', 'fleet');

  manager.registerType({
    id: 'work-plan',
    name: 'Work Plan',
    // WO-152: was 'L' (collided with panel-list).
    icon: '◧',
    category: 'agent',
    description: 'Persistent workspace checklist for multi-step work and cross-session task tracking',
    // W6.1: preload dropped — work-plan is MIGRATE-TO-MODAL (not yet
    // converted; WO-A/B). Only 'tokens' remains preloaded post-purge.
    retainOnClose: true,
    factory: () => new WorkPlanPanel(deps.workPlanStore),
  });

  manager.registerType({
    id: 'project-planning',
    name: 'Planning',
    icon: 'P',
    category: 'agent',
    description: 'Passive project planning artifacts: readiness, questions, decisions, language, task graph, and agent handoff metadata',
    // W6.1: preload dropped (MIGRATE-TO-MODAL, not yet converted).
    retainOnClose: true,
    factory: () => new ProjectPlanningPanel({
      service: deps.projectPlanningService,
      projectId: deps.projectPlanningProjectId,
      requestRender: deps.requestRender,
      submitAnswer: deps.submitPlanningAnswer,
      dismissPlanning: deps.dismissPlanning,
    }),
  });
}
