import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { InfiniteBuffer } from '../core/history.ts';
import type { SelectionResult, SelectionModal } from './selection-modal.ts';
import type { BookmarkModal } from './bookmark-modal.ts';
import type { SettingsModal } from './settings-modal.ts';
import type { SessionPickerModal } from './session-picker-modal.ts';
import type { ProfilePickerModal } from './profile-picker-modal.ts';
import type { HistorySearch } from './input-history.ts';
import type { ModelPickerModal } from './model-picker.ts';
import type { CommandContext } from './command-registry.ts';
import type { LiveTailModal } from '../renderer/live-tail-modal.ts';
import type { ProcessModal } from '../renderer/process-modal.ts';
import type { AgentDetailModal } from '../renderer/agent-detail-modal.ts';
import type { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { FilePickerModal } from './file-picker.ts';
import type { BlockActionsMenu, BlockActionId } from '../renderer/block-actions.ts';
import type { SearchManager } from './search.ts';
import type { OnboardingWizardAction, OnboardingWizardController } from './onboarding/onboarding-wizard.ts';
import { handleHistorySearchToken, handleOverlayToken, handleSearchModeToken } from './handler-ui-state.ts';
import { handleOnboardingWizardToken } from './onboarding/handler-onboarding-routes.ts';
import {
  handleBookmarkModalToken,
  handleProfilePickerToken,
  handleSelectionModalToken,
  handleSessionPickerToken,
  handleSettingsModalToken,
} from './handler-modal-routes.ts';
import {
  handleBlockActionsToken,
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleLiveTailToken,
  handleModelPickerToken,
  handleProcessModalToken,
} from './handler-picker-routes.ts';

export type ModalTokenRouteState = {
  history: InfiniteBuffer;
  searchShortcutMatch: boolean;
  selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  getSelectionCallback?: () => ((result: SelectionResult | null) => void) | null;
  setSelectionCallback?: (callback: ((result: SelectionResult | null) => void) | null) => void;
  bookmarkModal: BookmarkModal;
  settingsModal: SettingsModal;
  sessionPickerModal: SessionPickerModal;
  profilePickerModal: ProfilePickerModal;
  onboardingWizard: OnboardingWizardController;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  historySearch: HistorySearch;
  prompt: string;
  cursorPos: number;
  modelPicker: ModelPickerModal;
  modalStack: string[];
  commandContext?: CommandContext;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
  liveTailModal: LiveTailModal;
  processModal: ProcessModal;
  agentDetailModal: AgentDetailModal;
  contextInspectorModal: ContextInspectorModal;
  modalOpened: (name: string) => void;
  filePicker: FilePickerModal;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextImageId: number;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  formatFileSize: (bytes: number) => string;
  mediaTypeFromExt: (ext: string) => string;
  imageExtensions: string[];
  blockActionsMenu: BlockActionsMenu;
  executeBlockAction: (actionId: BlockActionId) => void;
  searchManager: SearchManager;
  scroll: (delta: number) => void;
  getScrollTop: () => number;
  /** Callback to open the model picker with a specific target (helper or tool). Optional — only wired when available. */
  openModelPickerWithTarget?: (
    target: import('./model-picker.ts').ModelPickerTarget,
    source?: 'settings' | 'onboarding',
  ) => boolean;
  openProviderModelPickerWithTarget?: (
    target: import('./model-picker.ts').ModelPickerTarget,
    source?: 'settings' | 'onboarding',
  ) => boolean;
  clearOnboardingModelPickerCancelState?: () => void;
  restoreOnboardingModelPickerCancelState?: () => void;
  onModelPickerCommit?: () => boolean;
  onOnboardingAction?: (action: OnboardingWizardAction) => void;
};

export function handleModalTokenRoutes(state: ModalTokenRouteState, token: InputToken): {
  handled: boolean;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  prompt: string;
  cursorPos: number;
  nextImageId: number;
} {
  if (handleSearchModeToken({
    searchManager: state.searchManager,
    requestRender: state.requestRender,
    scroll: state.scroll,
    getScrollTop: state.getScrollTop,
    getViewportHeight: state.getViewportHeight,
  }, token, state.history, state.searchShortcutMatch)) {
    return withState(state, true);
  }

  const selectionState = {
    selectionModal: state.selectionModal,
    selectionCallback: state.selectionCallback,
    getSelectionCallback: state.getSelectionCallback,
    setSelectionCallback: state.setSelectionCallback,
    modalStack: state.modalStack,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  };
  if (handleSelectionModalToken(selectionState, token)) {
    return withState(state, true, { selectionCallback: selectionState.selectionCallback });
  }

  if (handleBookmarkModalToken({
    bookmarkModal: state.bookmarkModal,
    commandContext: state.commandContext,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  if (handleSettingsModalToken({
    settingsModal: state.settingsModal,
    commandContext: state.commandContext,
    openModelPickerWithTarget: state.openModelPickerWithTarget,
    openProviderModelPickerWithTarget: state.openProviderModelPickerWithTarget,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  if (handleSessionPickerToken({
    sessionPickerModal: state.sessionPickerModal,
    commandContext: state.commandContext,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  if (handleProfilePickerToken({
    profilePickerModal: state.profilePickerModal,
    commandContext: state.commandContext,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  const overlayState = {
    helpOverlayActive: state.helpOverlayActive,
    helpScrollOffset: state.helpScrollOffset,
    shortcutsOverlayActive: state.shortcutsOverlayActive,
    shortcutsScrollOffset: state.shortcutsScrollOffset,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  };
  if (handleOverlayToken(overlayState, token)) {
    return withState(state, true, overlayState);
  }

  const historyState = {
    historySearch: state.historySearch,
    prompt: state.prompt,
    cursorPos: state.cursorPos,
    requestRender: state.requestRender,
  };
  if (handleHistorySearchToken(historyState, token)) {
    return withState(state, true, historyState);
  }

  if (handleModelPickerToken({
    modelPicker: state.modelPicker,
    modalStack: state.modalStack,
    commandContext: state.commandContext,
    getViewportHeight: state.getViewportHeight,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
    onModelPickerCommit: state.onModelPickerCommit,
  }, token)) {
    return withState(state, true);
  }

  if (handleOnboardingWizardToken({
    onboardingWizard: state.onboardingWizard,
    getViewportHeight: state.getViewportHeight,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
    openModelPickerWithTarget: state.openModelPickerWithTarget,
    onAction: state.onOnboardingAction,
  }, token)) {
    return withState(state, true);
  }

  if (handleLiveTailToken({
    liveTailModal: state.liveTailModal,
    processModal: state.processModal,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  if (handleEscapeOnlyModalToken({
    active: state.agentDetailModal.active,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  if (handleEscapeOnlyModalToken({
    active: state.contextInspectorModal.active,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  if (handleProcessModalToken({
    processModal: state.processModal,
    liveTailModal: state.liveTailModal,
    agentDetailModal: state.agentDetailModal,
    modalOpened: state.modalOpened,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  const filePickerState = {
    filePicker: state.filePicker,
    prompt: state.prompt,
    cursorPos: state.cursorPos,
    imageRegistry: state.imageRegistry,
    nextImageId: state.nextImageId,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
    saveUndoState: state.saveUndoState,
    ensureInputCursorVisible: state.ensureInputCursorVisible,
    formatFileSize: state.formatFileSize,
    mediaTypeFromExt: state.mediaTypeFromExt,
    imageExtensions: state.imageExtensions,
  };
  if (handleFilePickerToken(filePickerState, token)) {
    return withState(state, true, {
      prompt: filePickerState.prompt,
      cursorPos: filePickerState.cursorPos,
      nextImageId: filePickerState.nextImageId,
    });
  }

  if (handleBlockActionsToken({
    blockActionsMenu: state.blockActionsMenu,
    executeBlockAction: state.executeBlockAction,
    requestRender: state.requestRender,
    handleEscape: state.handleEscape,
  }, token)) {
    return withState(state, true);
  }

  return withState(state, false);
}

function withState(
  state: ModalTokenRouteState,
  handled: boolean,
  overrides: Partial<{
    selectionCallback: ((result: SelectionResult | null) => void) | null;
    helpOverlayActive: boolean;
    helpScrollOffset: number;
    shortcutsOverlayActive: boolean;
    shortcutsScrollOffset: number;
    prompt: string;
    cursorPos: number;
    nextImageId: number;
  }> = {},
) {
  return {
    handled,
    selectionCallback: overrides.selectionCallback ?? state.selectionCallback,
    helpOverlayActive: overrides.helpOverlayActive ?? state.helpOverlayActive,
    helpScrollOffset: overrides.helpScrollOffset ?? state.helpScrollOffset,
    shortcutsOverlayActive: overrides.shortcutsOverlayActive ?? state.shortcutsOverlayActive,
    shortcutsScrollOffset: overrides.shortcutsScrollOffset ?? state.shortcutsScrollOffset,
    prompt: overrides.prompt ?? state.prompt,
    cursorPos: overrides.cursorPos ?? state.cursorPos,
    nextImageId: overrides.nextImageId ?? state.nextImageId,
  };
}
