import type { CommandContext } from './command-registry.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { Panel } from '../panels/types.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import { FileExplorerPanel } from '../panels/file-explorer-panel.ts';
import { FilePreviewPanel } from '../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../panels/symbol-outline-panel.ts';
import { ApprovalPanel } from '../panels/approval-panel.ts';

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

  return false;
}
