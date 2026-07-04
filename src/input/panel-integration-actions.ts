import type { CommandContext } from './command-registry.ts';
import type { Panel } from '../panels/types.ts';
import type { PanelManager } from '../panels/panel-manager.ts';

// W6.1 (the purge): every instanceof-routed branch this file used to carry
// (FileExplorerPanel/FilePreviewPanel/SymbolOutlinePanel — DELETE;
// ApprovalPanel/TasksPanel/OrchestrationPanel/AgentInspectorPanel —
// RETIRE-INTO-FLEET) targeted a panel class that no longer exists. Panels
// migrated onto the formal `Panel.handlePanelIntegrationAction` hook (the
// preferred seam — see the comment below) are unaffected; this function now
// only provides that passthrough. See
// .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1) for the disposition
// map.
export function handlePanelIntegrationAction(
  panelManager: PanelManager,
  activePanel: Panel | null,
  key: string,
  commandContext?: CommandContext,
): boolean {
  if (!activePanel) return false;

  // Prefer the panel's own integration hook when it provides one. Panels migrated
  // onto the formal hook opt out of the instanceof routing below.
  if (activePanel.handlePanelIntegrationAction) {
    const consumed = activePanel.handlePanelIntegrationAction(key, {
      panelManager,
      executeCommand: commandContext?.executeCommand,
    });
    if (consumed) return true;
  }

  return false;
}
