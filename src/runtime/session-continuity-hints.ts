/**
 * session-continuity-hints — the recovery snapshot's continuity summary.
 *
 * Extracted from main.ts (which sits at the architecture line cap) so the
 * startup wiring there stays within budget. Builds the small counts/paths
 * bundle written into the recovery file so a resumed session can describe what
 * was in flight (pending approvals, active/blocked tasks, remotes, worktrees,
 * open panels) without re-reading live state.
 */
import type { UiReadModels } from './ui-read-models.ts';
import type { PanelManager } from '../panels/panel-manager.ts';

/**
 * The continuity summary written into the recovery file. A loose serializable
 * bag (Record) because it is JSON-persisted and read back by the recovery
 * continuity-hints consumer, which types it structurally.
 */
export function createSessionContinuityHintsBuilder(deps: {
  readonly readModels: UiReadModels;
  readonly panelManager: Pick<PanelManager, 'getAllOpen'>;
}): () => Record<string, unknown> {
  return () => {
    const sessionSnapshot = deps.readModels.session.getSnapshot();
    const tasksSnapshot = deps.readModels.tasks.getSnapshot();
    const remoteSnapshot = deps.readModels.remote.getSnapshot();
    const worktreeSnapshot = deps.readModels.worktrees.getSnapshot();
    return {
      pendingApprovals: sessionSnapshot.pendingApproval ? 1 : 0,
      activeTasks: tasksSnapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
      blockedTasks: tasksSnapshot.tasks.filter((task) => task.status === 'blocked').length,
      remoteContracts: remoteSnapshot.contracts.length,
      remoteRunners: remoteSnapshot.contracts.slice(0, 4).map((contract) => contract.runnerId),
      worktreeCount: worktreeSnapshot.records.length,
      worktreePaths: worktreeSnapshot.records.slice(0, 3).map((record) => record.path),
      openPanels: deps.panelManager.getAllOpen().map((panel) => panel.id),
    };
  };
}
