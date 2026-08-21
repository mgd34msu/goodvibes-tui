import type { PanelManager } from '../panel-manager.ts';
import type { ResolvedBuiltinPanelDeps } from './shared.ts';

// (the purge): thinking, tools, inspector, and wrfc were registered here
// before the purge. thinking/tools were DELETE-disposition (no surviving
// human surface, thinking already renders inline in the transcript, tool
// results render inline plus per-node in Fleet); inspector/wrfc were
// RETIRE-INTO-FLEET (their live console is subsumed by the Fleet panel,
// operations.ts:84). See registerOperationsPanels for the fleet
// registration and .goodvibes/audit/2026-07-04-wave6-briefs.json for
// the full disposition map.
export function registerAgentPanels(manager: PanelManager, deps: ResolvedBuiltinPanelDeps): void {
  // Compat: '/panel open agent-logs' and 'inspector' (and any saved
  // layout/muscle memory) still resolve, redirected straight to fleet.
  // Repointed from agent-logs->inspector now that inspector itself
  // is retired; alias resolution is a single hop (PanelManager._resolveId),
  // so this must point at the real surviving id, not at another alias.
  manager.registerAlias('agent-logs', 'fleet');
  manager.registerAlias('inspector', 'fleet');
  manager.registerAlias('wrfc', 'fleet');

  // (the purge), group B: 'work-plan' and 'project-planning'
  // migrated to the 'work-plan-modal' / 'planning-modal' config-modal surfaces.
  // Their surfaces AND panel→modal redirects are registered centrally in
  // registerBuiltinModals (builtin-modals.ts). Panel registrations retired here.
  void deps;
}
