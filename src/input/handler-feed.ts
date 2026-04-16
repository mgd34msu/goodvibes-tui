import type { InputToken } from '@pellux/goodvibes-sdk/platform/core/tokenizer';
import type { InfiniteBuffer } from '../core/history.ts';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import type { InputHistory, HistorySearch } from './input-history.ts';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { AgentDetailModal } from '../renderer/agent-detail-modal.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import {
  IMAGE_EXTENSIONS,
  formatFileSize,
  mediaTypeFromExt,
} from './handler-content-actions.ts';
import {
  handleIndicatorFocusToken,
  handleMouseToken,
  handlePanelFocusToken,
  handlePromptKeyToken,
  handlePromptTextToken,
} from './handler-feed-routes.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import { handleGlobalShortcutToken } from './handler-shortcuts.ts';
import type { Panel } from '../panels/types.ts';
import { handlePanelIntegrationAction } from './panel-integration-actions.ts';
import { SelectionManager } from './selection.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { KeybindingsManager } from './keybindings.ts';

export interface InputFeedContext {
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  panelFocused: boolean;
  indicatorFocused: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  nextPasteId: number;
  nextImageId: number;
  mouseDownRow: number;
  mouseDownCol: number;
  contentWidth: number;
  readonly pasteRegistry: Map<string, string>;
  readonly imageRegistry: Map<string, { data: string; mediaType: string }>;
  readonly selection: SelectionManager;
  readonly selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  readonly bookmarkModal: BookmarkModal;
  readonly settingsModal: SettingsModal;
  readonly sessionPickerModal: SessionPickerModal;
  readonly profilePickerModal: ProfilePickerModal;
  readonly historySearch: HistorySearch;
  readonly commandRegistry: CommandRegistry | null;
  readonly commandContext: CommandContext | undefined;
  readonly autocomplete: AutocompleteEngine | null;
  readonly filePicker: FilePickerModal;
  readonly modelPicker: ModelPickerModal;
  readonly processModal: ProcessModal;
  readonly liveTailModal: LiveTailModal;
  readonly agentDetailModal: AgentDetailModal;
  readonly contextInspectorModal: ContextInspectorModal;
  readonly blockActionsMenu: BlockActionsMenu;
  readonly searchManager: SearchManager;
  readonly panelManager: PanelManager;
  readonly keybindingsManager: KeybindingsManager;
  readonly modalStack: string[];
  readonly inputHistory: InputHistory | null;
  readonly conversationManager: ConversationManager | null;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  readonly requestRender: () => void;
  readonly modalOpened: (name: string) => void;
  readonly handleEscape: () => void;
  readonly handleCopy: () => void;
  readonly handleCtrlC: () => void;
  readonly handleBlockCopy: () => void;
  readonly handleBookmark: () => void;
  readonly handleBlockSave: () => void;
  readonly handleDiffApply: () => boolean;
  readonly handleUndo: () => void;
  readonly handleRedo: () => void;
  readonly handlePaste: () => void;
  readonly saveUndoState: () => void;
  readonly ensureInputCursorVisible: (contentWidth?: number) => void;
  readonly registerPaste: (content: string) => string;
  readonly executeBlockAction: (id: string) => void;
  readonly cyclePanelTab: (direction: 'next' | 'prev') => void;
  readonly onPanelInputConsumed: (activePanel: Panel | null, key: string) => void;
  readonly getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  readonly moveCursorVertical: (direction: -1 | 1) => boolean;
  readonly handlePathCompletion: () => boolean;
  readonly handleBlockToggle: () => void;
  readonly findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  readonly cleanupMarkerRegistry: (text: string) => void;
  readonly expandPrompt: (text: string) => string | import('@pellux/goodvibes-sdk/platform/providers/interface').ContentPart[];
  readonly exitApp: () => void;
}

export function feedInputTokens(context: InputFeedContext, tokens: readonly InputToken[]): void {
  const history = context.getHistory();
  const viewportHeight = context.getViewportHeight();
  const scrollTop = context.getScrollTop();
  const lineCount = history.getLineCount();
  const keybindings = context.keybindingsManager;

  for (const token of tokens) {
    if (token.type === 'key' && context.keybindingsManager.matches('clear-cancel', token)) {
      context.handleCtrlC();
      continue;
    }

    const modalRoute = handleModalTokenRoutes({
      history,
      searchShortcutMatch: token.type === 'key' && keybindings.matches('search', token),
      selectionModal: context.selectionModal,
      selectionCallback: context.selectionCallback,
      bookmarkModal: context.bookmarkModal,
      settingsModal: context.settingsModal,
      sessionPickerModal: context.sessionPickerModal,
      profilePickerModal: context.profilePickerModal,
      helpOverlayActive: context.helpOverlayActive,
      helpScrollOffset: context.helpScrollOffset,
      shortcutsOverlayActive: context.shortcutsOverlayActive,
      shortcutsScrollOffset: context.shortcutsScrollOffset,
      historySearch: context.historySearch,
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      modelPicker: context.modelPicker,
      modalStack: context.modalStack,
      commandContext: context.commandContext,
      getViewportHeight: context.getViewportHeight,
      requestRender: context.requestRender,
      handleEscape: context.handleEscape,
      liveTailModal: context.liveTailModal,
      processModal: context.processModal,
      agentDetailModal: context.agentDetailModal,
      contextInspectorModal: context.contextInspectorModal,
      modalOpened: context.modalOpened,
      filePicker: context.filePicker,
      imageRegistry: context.imageRegistry,
      nextImageId: context.nextImageId,
      saveUndoState: context.saveUndoState,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      formatFileSize,
      mediaTypeFromExt,
      imageExtensions: IMAGE_EXTENSIONS,
      blockActionsMenu: context.blockActionsMenu,
      executeBlockAction: context.executeBlockAction,
      searchManager: context.searchManager,
      scroll: context.scroll,
      getScrollTop: context.getScrollTop,
      openModelPickerWithTarget: context.commandContext?.openModelPicker
        ? (target: import('./model-picker.ts').ModelPickerTarget) => {
            context.modelPicker.target = target;
            context.commandContext!.openModelPicker!();
          }
        : undefined,
    }, token);
    context.selectionCallback = modalRoute.selectionCallback;
    context.helpOverlayActive = modalRoute.helpOverlayActive;
    context.helpScrollOffset = modalRoute.helpScrollOffset;
    context.shortcutsOverlayActive = modalRoute.shortcutsOverlayActive;
    context.shortcutsScrollOffset = modalRoute.shortcutsScrollOffset;
    context.prompt = modalRoute.prompt;
    context.cursorPos = modalRoute.cursorPos;
    context.nextImageId = modalRoute.nextImageId;
    if (modalRoute.handled) {
      continue;
    }

    if (token.type === 'key') {
      const shortcutState = {
        panelFocused: context.panelFocused,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        commandMode: context.commandMode,
        autocomplete: context.autocomplete,
        historySearch: context.historySearch,
        searchManager: context.searchManager,
        conversationManager: context.conversationManager,
        commandContext: context.commandContext,
        contentWidth: context.contentWidth,
        getScrollTop: context.getScrollTop,
        getWrappedPromptInfo: context.getWrappedPromptInfo,
        saveUndoState: context.saveUndoState,
        requestRender: context.requestRender,
        scroll: context.scroll,
        ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
        handleCopy: context.handleCopy,
        handleCtrlC: context.handleCtrlC,
        handleBlockCopy: context.handleBlockCopy,
        handleBookmark: context.handleBookmark,
        handleBlockSave: context.handleBlockSave,
        handleDiffApply: context.handleDiffApply,
        handleUndo: context.handleUndo,
        handleRedo: context.handleRedo,
        handlePaste: context.handlePaste,
        handleEscape: context.handleEscape,
        cyclePanelTab: context.cyclePanelTab,
        panelManager: context.panelManager,
        keybindingsManager: context.keybindingsManager,
      };
      if (handleGlobalShortcutToken(shortcutState, token, viewportHeight)) {
        context.prompt = shortcutState.prompt;
        context.cursorPos = shortcutState.cursorPos;
        context.commandMode = shortcutState.commandMode;
        continue;
      }
    }

    const panelRoute = handlePanelFocusToken({
      panelFocused: context.panelFocused,
      commandMode: context.commandMode,
      searchActive: context.searchManager.active,
      autocompleteActive: !!context.autocomplete?.isActive,
      requestRender: context.requestRender,
      handlePathCompletion: context.handlePathCompletion,
      cyclePanelTab: context.cyclePanelTab,
      panelManager: context.panelManager,
      keybindingsManager: context.keybindingsManager,
      onPanelInputConsumed: context.onPanelInputConsumed,
    }, token);
    context.panelFocused = panelRoute.panelFocused;
    if (panelRoute.handled) {
      continue;
    }

    const indicatorRoute = handleIndicatorFocusToken({
      indicatorFocused: context.indicatorFocused,
      modalOpened: context.modalOpened,
      processModal: context.processModal,
      requestRender: context.requestRender,
    }, token);
    context.indicatorFocused = indicatorRoute.indicatorFocused;
    if (indicatorRoute.handled) {
      continue;
    }

    const textRoute = handlePromptTextToken({
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      commandMode: context.commandMode,
      nextPasteId: context.nextPasteId,
      nextImageId: context.nextImageId,
      pasteRegistry: context.pasteRegistry,
      imageRegistry: context.imageRegistry,
      inputHistory: context.inputHistory,
      commandRegistry: context.commandRegistry,
      commandContext: context.commandContext,
      autocomplete: context.autocomplete,
      filePicker: context.filePicker,
      modalOpened: context.modalOpened,
      saveUndoState: context.saveUndoState,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      registerPaste: context.registerPaste,
      requestRender: context.requestRender,
    }, token);
    if (textRoute.handled) {
      context.prompt = textRoute.prompt;
      context.cursorPos = textRoute.cursorPos;
      context.commandMode = textRoute.commandMode;
      continue;
    }

    if (token.type === 'key') {
      const commandState = {
        commandMode: context.commandMode,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        autocomplete: context.autocomplete,
        modalStack: context.modalStack,
        commandRegistry: context.commandRegistry,
        commandContext: context.commandContext,
        conversationManager: context.conversationManager,
        requestRender: context.requestRender,
        handleEscape: context.handleEscape,
      };
      if (handleCommandModeToken(commandState, token)) {
        context.commandMode = commandState.commandMode;
        context.prompt = commandState.prompt;
        context.cursorPos = commandState.cursorPos;
        continue;
      }

      const keyRoute = handlePromptKeyToken({
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        commandMode: context.commandMode,
        contentWidth: context.contentWidth,
        inputHistory: context.inputHistory,
        indicatorFocused: context.indicatorFocused,
        conversationManager: context.conversationManager,
        commandContext: context.commandContext,
        autocomplete: context.autocomplete,
        blockActionsMenu: { open: (block: BlockMeta) => context.blockActionsMenu.open(block) },
        processModal: context.processModal,
        modalOpened: context.modalOpened,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: context.ensureInputCursorVisible,
        getWrappedPromptInfo: context.getWrappedPromptInfo,
        moveCursorVertical: context.moveCursorVertical,
        handlePathCompletion: context.handlePathCompletion,
        handleBlockToggle: context.handleBlockToggle,
        findMarkerAtPos: context.findMarkerAtPos,
        cleanupMarkerRegistry: context.cleanupMarkerRegistry,
        expandPrompt: context.expandPrompt,
        scroll: context.scroll,
        exitApp: context.exitApp,
        requestRender: context.requestRender,
      }, token);
      if (keyRoute.handled) {
        context.prompt = keyRoute.prompt;
        context.cursorPos = keyRoute.cursorPos;
        context.commandMode = keyRoute.commandMode;
        context.indicatorFocused = keyRoute.indicatorFocused;
        continue;
      }
    } else if (token.type === 'mouse') {
      const mouseRoute = handleMouseToken({
        conversationManager: context.conversationManager,
        selection: context.selection,
        mouseDownRow: context.mouseDownRow,
        mouseDownCol: context.mouseDownCol,
        scrollTop,
        viewportHeight,
        lineCount,
        scroll: context.scroll,
        requestRender: context.requestRender,
        handlePaste: context.handlePaste,
        handleCopy: context.handleCopy,
      }, token);
      context.mouseDownRow = mouseRoute.mouseDownRow;
      context.mouseDownCol = mouseRoute.mouseDownCol;
      if (mouseRoute.handled) {
        continue;
      }
    }
  }

  context.requestRender();
}

export function defaultPanelInputConsumer(
  panelManager: PanelManager,
  activePanel: Panel | null,
  key: string,
  commandContext?: CommandContext,
): void {
  handlePanelIntegrationAction(panelManager, activePanel, key, commandContext);
}
