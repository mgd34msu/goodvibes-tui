import type { Line } from '../types/grid.ts';
import type { ConversationManager } from '../core/conversation';
import type { CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { renderFilePickerOverlay } from './file-picker-overlay.ts';
import { renderModelWorkspace } from './model-workspace.ts';
import { renderSelectionModalOverlay } from './selection-modal-overlay.ts';
import { renderSearchOverlay } from './search-overlay.ts';
import { renderHistorySearchOverlay } from './history-search-overlay.ts';
import { renderProcessModal } from './process-modal.ts';
import { renderAgentDetailModal } from './agent-detail-modal.ts';
import { renderLiveTailModal } from './live-tail-modal.ts';
import { renderContextInspector } from './context-inspector.ts';
import { renderSettingsModal } from './settings-modal.ts';
import { renderMcpWorkspace } from './mcp-workspace.ts';
import { renderSessionPickerModal } from './session-picker-modal.ts';
import { renderProfilePickerModal } from './profile-picker-modal.ts';
import { renderBookmarkModal } from './bookmark-modal.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from './help-overlay.ts';
import { renderAutocompleteOverlay } from './autocomplete-overlay.ts';
import { renderOnboardingWizard } from './onboarding/onboarding-wizard.ts';
import { overlayViewportBottom, replaceViewportWithOverlay } from './conversation-layout.ts';

export interface ConversationOverlayContext {
  readonly input: InputHandler;
  readonly conversation: ConversationManager;
  readonly commandRegistry: CommandRegistry;
  readonly keybindingsManager: KeybindingsManager;
  readonly conversationWidth: number;
  readonly viewportHeight: number;
  readonly contextWindow?: number;
}

export function applyConversationOverlays(
  viewport: Line[],
  context: ConversationOverlayContext,
): Line[] {
  const { input, conversation, commandRegistry, keybindingsManager, conversationWidth, viewportHeight, contextWindow } = context;
  let next = viewport;
  const bottomDockInset = 1 + (input.searchManager.active || input.historySearch.active ? 1 : 0);

  // Overlay posture rule: workspaces (onboarding, model, settings, mcp, help,
  // shortcuts) claim the full viewport and are mutually exclusive with docked
  // pickers/modals. Once a fullscreen workspace claims the screen, no docked
  // overlay is drawn on top of it — enforcing a single visible overlay even if
  // stray state survives the handler's clearModalStack. The input layer keeps
  // the modal stack to one entry; this is the renderer-side backstop.
  let fullscreenClaimed = false;

  if (input.onboardingWizard.active) {
    const lines = renderOnboardingWizard(input.onboardingWizard, conversationWidth, viewportHeight);
    next = replaceViewportWithOverlay(lines, conversationWidth, viewportHeight);
    fullscreenClaimed = true;
  }

  if (!fullscreenClaimed && input.filePicker.active) {
    const lines = renderFilePickerOverlay(input.filePicker, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (input.modelPicker.active) {
    const lines = renderModelWorkspace(input.modelPicker, conversationWidth, viewportHeight);
    next = replaceViewportWithOverlay(lines, conversationWidth, viewportHeight);
    fullscreenClaimed = true;
  }

  if (!fullscreenClaimed && input.selectionModal.active) {
    const lines = renderSelectionModalOverlay(input.selectionModal, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (input.searchManager.active) {
    next.push(...renderSearchOverlay(input.searchManager, conversationWidth));
  }

  if (input.historySearch.active) {
    next.push(...renderHistorySearchOverlay(input.historySearch, conversationWidth));
  }

  if (!fullscreenClaimed && input.processModal.active) {
    const lines = renderProcessModal(input.processModal, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (!fullscreenClaimed && input.agentDetailModal.active) {
    const lines = renderAgentDetailModal(input.agentDetailModal, conversationWidth);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (!fullscreenClaimed && input.liveTailModal.active) {
    const lines = renderLiveTailModal(input.liveTailModal, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (!fullscreenClaimed && input.contextInspectorModal.active) {
    const lines = renderContextInspector(conversation, conversationWidth, viewportHeight, contextWindow);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (input.settingsModal.active) {
    const lines = renderSettingsModal(input.settingsModal, conversationWidth, viewportHeight);
    next = replaceViewportWithOverlay(lines, conversationWidth, viewportHeight);
    fullscreenClaimed = true;
  }

  if (input.mcpWorkspace.active) {
    const lines = renderMcpWorkspace(input.mcpWorkspace, conversationWidth, viewportHeight);
    next = replaceViewportWithOverlay(lines, conversationWidth, viewportHeight);
    fullscreenClaimed = true;
  }

  if (!fullscreenClaimed && input.sessionPickerModal.active) {
    const lines = renderSessionPickerModal(input.sessionPickerModal, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (!fullscreenClaimed && input.profilePickerModal.active) {
    const lines = renderProfilePickerModal(input.profilePickerModal, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (!fullscreenClaimed && input.bookmarkModal.active) {
    const lines = renderBookmarkModal(input.bookmarkModal, conversationWidth, viewportHeight);
    next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
  }

  if (input.helpOverlayActive) {
    const lines = renderHelpOverlay(conversationWidth, keybindingsManager, commandRegistry.getAll(), input.helpScrollOffset, viewportHeight);
    next = replaceViewportWithOverlay(lines, conversationWidth, viewportHeight);
    fullscreenClaimed = true;
  }

  if (input.shortcutsOverlayActive) {
    const lines = renderShortcutsOverlay(conversationWidth, keybindingsManager, input.shortcutsScrollOffset, viewportHeight);
    next = replaceViewportWithOverlay(lines, conversationWidth, viewportHeight);
    fullscreenClaimed = true;
  }

  if (!fullscreenClaimed && input.commandMode && input.autocomplete?.isActive) {
    const lines = renderAutocompleteOverlay(input.autocomplete, conversationWidth, viewportHeight);
    if (lines.length > 0) {
      next = overlayViewportBottom(next, lines, conversationWidth, viewportHeight, bottomDockInset);
    }
  }

  return next;
}
