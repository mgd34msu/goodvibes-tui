import type { CommandContext } from './command-registry.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { Panel } from '../panels/types.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import { FileExplorerPanel } from '../panels/file-explorer-panel.ts';
import { FilePreviewPanel } from '../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../panels/symbol-outline-panel.ts';
import { ApprovalPanel } from '../panels/approval-panel.ts';
import { TasksPanel } from '../panels/tasks-panel.ts';
import { OrchestrationPanel } from '../panels/orchestration-panel.ts';
import { AgentInspectorPanel } from '../panels/agent-inspector-panel.ts';
import { DiffPanel } from '../panels/diff-panel.ts';

function ensurePreviewPanel(panelManager: PanelManager): FilePreviewPanel | null {
  const existing = panelManager.getPanel('preview');
  if (existing instanceof FilePreviewPanel) {
    const pane = panelManager.getPaneOf('preview');
    panelManager.activateById('preview');
    if (pane) panelManager.focusPane(pane);
    return existing;
  }
  const targetPane: 'top' | 'bottom' = panelManager.isBottomPaneVisible()
    ? (panelManager.getFocusedPane() === 'top' ? 'bottom' : 'top')
    : 'bottom';
  const opened = panelManager.open('preview', targetPane);
  panelManager.show();
  panelManager.focusPane(targetPane);
  return opened instanceof FilePreviewPanel ? opened : null;
}

// WO-133: shared by explorer's and preview's 'd' (diff) key — same
// open/focus bridge as ensurePreviewPanel above.
function ensureDiffPanel(panelManager: PanelManager): DiffPanel | null {
  const existing = panelManager.getPanel('diff');
  if (existing instanceof DiffPanel) {
    const pane = panelManager.getPaneOf('diff');
    panelManager.activateById('diff');
    if (pane) panelManager.focusPane(pane);
    return existing;
  }
  const targetPane: 'top' | 'bottom' = panelManager.isBottomPaneVisible()
    ? (panelManager.getFocusedPane() === 'top' ? 'bottom' : 'top')
    : 'bottom';
  const opened = panelManager.open('diff', targetPane);
  panelManager.show();
  panelManager.focusPane(targetPane);
  return opened instanceof DiffPanel ? opened : null;
}

// Exported so a future preview-reload action (e.g. an explicit "r" reload
// key) can re-sync the outline against the same file without duplicating
// this lookup — the panel-integration wiring for that key lands separately.
export function syncSymbolOutlineFromPreview(panelManager: PanelManager, previewPanel: FilePreviewPanel): void {
  const symbols = panelManager.getPanel('symbols');
  const filePath = previewPanel.getCurrentFilePath();
  const source = previewPanel.getSource();
  if (symbols instanceof SymbolOutlinePanel && filePath && source !== null) {
    symbols.loadFile(filePath, source);
  }
}

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

  if ((key === 'enter' || key === 'return' || key === 'right') && activePanel instanceof FileExplorerPanel) {
    const filePath = activePanel.getFocusedFilePath();
    if (!filePath) return false;
    const previewPanel = ensurePreviewPanel(panelManager);
    if (!previewPanel) return false;
    previewPanel.openFile(filePath);
    syncSymbolOutlineFromPreview(panelManager, previewPanel);
    return true;
  }

  // WO-133: 'd' on the explorer diffs the currently focused file, and 'd' on
  // the preview diffs whatever file is currently open — both against HEAD,
  // both via the same DiffPanel.showFileDiffs entry point.
  if (key === 'd' && activePanel instanceof FileExplorerPanel) {
    const filePath = activePanel.getFocusedFilePath();
    if (!filePath) return false;
    const diffPanel = ensureDiffPanel(panelManager);
    if (!diffPanel) return false;
    void diffPanel.showFileDiffs([filePath], 'HEAD').catch((err) => {
      logger.debug('explorer diff dispatch failed', { err });
    });
    return true;
  }

  if (key === 'd' && activePanel instanceof FilePreviewPanel) {
    const filePath = activePanel.getCurrentFilePath();
    if (!filePath) return false;
    const diffPanel = ensureDiffPanel(panelManager);
    if (!diffPanel) return false;
    void diffPanel.showFileDiffs([filePath], 'HEAD').catch((err) => {
      logger.debug('preview diff dispatch failed', { err });
    });
    return true;
  }

  // WO-133: 'r' on the preview reloads the open file from disk, then
  // re-syncs the symbol outline against the refreshed content (WO-126's
  // async tree-sitter loadFile via syncSymbolOutlineFromPreview above) once
  // the reload actually settles.
  if (key === 'r' && activePanel instanceof FilePreviewPanel) {
    const reloaded = activePanel.consumePendingReload();
    if (!reloaded) return false;
    void reloaded.then(() => syncSymbolOutlineFromPreview(panelManager, activePanel)).catch((err) => {
      logger.debug('preview reload dispatch failed', { err });
    });
    return true;
  }

  if ((key === 'enter' || key === 'return') && activePanel instanceof SymbolOutlinePanel) {
    const location = activePanel.getSelectedLocation();
    if (!location) return false;
    const previewPanel = ensurePreviewPanel(panelManager);
    if (!previewPanel) return false;
    if (previewPanel.getCurrentFilePath() !== location.path) {
      previewPanel.openFile(location.path);
      syncSymbolOutlineFromPreview(panelManager, previewPanel);
    }
    previewPanel.goToLine(location.line);
    return true;
  }

  if ((key === 'enter' || key === 'return') && activePanel instanceof ApprovalPanel) {
    const command = activePanel.getSelectedCommand();
    if (!command || !commandContext?.executeCommand) return false;
    const parts = command.replace(/^\//, '').split(/\s+/).filter(Boolean);
    const [name, ...args] = parts;
    if (!name) return false;
    void commandContext.executeCommand(name, args).catch((err) => { logger.debug('approval panel command dispatch failed', { err }); });
    return true;
  }

  // WO-131: Enter on a Tasks row — agent-kind tasks jump straight to the Agent
  // Inspector (which owns the deep per-agent timeline); everything else's
  // advertised worktree follow-up is dispatched for real via ctx.executeCommand
  // instead of being printed as a static "/worktree task <task-id>" signpost.
  // w dispatches the task-family posture review the header line advertises.
  if ((key === 'enter' || key === 'return' || key === 'w') && activePanel instanceof TasksPanel) {
    const followUp = activePanel.consumePendingFollowUp();
    if (!followUp) return false;
    if (followUp.kind === 'agent-jump') {
      const inspector = panelManager.open('inspector');
      if (!(inspector instanceof AgentInspectorPanel)) return false;
      inspector.inspectAgent(followUp.agentId);
      return true;
    }
    if (!commandContext?.executeCommand) return false;
    if (followUp.kind === 'teamwork-review') {
      void commandContext.executeCommand('teamwork', ['review']).catch((err) => {
        logger.debug('tasks panel teamwork review dispatch failed', { err });
      });
      return true;
    }
    void commandContext.executeCommand('worktree', ['task', followUp.taskId]).catch((err) => {
      logger.debug('tasks panel worktree review dispatch failed', { err });
    });
    return true;
  }

  // WO-131: Enter on a node-focused Orchestration row jumps to the Agent
  // Inspector (agent-backed nodes) or the Tasks panel (task-backed nodes).
  if ((key === 'enter' || key === 'return') && activePanel instanceof OrchestrationPanel) {
    const jump = activePanel.consumePendingNodeJump();
    if (!jump) return false;
    if (jump.kind === 'agent-jump') {
      const inspector = panelManager.open('inspector');
      if (!(inspector instanceof AgentInspectorPanel)) return false;
      inspector.inspectAgent(jump.id);
      return true;
    }
    panelManager.open('tasks');
    return true;
  }

  return false;
}
