import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
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
import type { McpWorkspace } from './mcp-workspace.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import type { OnboardingWizardController } from './onboarding/onboarding-wizard.ts';
import type { OnboardingWizardAction } from './onboarding/onboarding-wizard.ts';
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
  type PanelMouseLayout,
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
import type { ModelPickerTarget } from './model-picker.ts';
import type { KillRing } from './kill-ring.ts';
import type { FocusTracker } from '../core/focus-tracker.ts';

/**
 * InputFeedContext — The single long-lived context object passed to feedInputTokens
 * on every keystroke. Allocated once at InputHandler construction; mutated in place
 * per-feed to avoid per-keystroke GC pressure from ~80-field object allocation.
 *
 * **Mutable per-feed** (synced from handler at the top of every feed() call, and
 * updated inside action closures via syncFeedContextMutableFields):
 *   - `prompt`, `cursorPos` — current text buffer state
 *   - `commandMode`, `panelFocused`, `indicatorFocused` — focus-mode flags
 *   - `helpOverlayActive`, `helpScrollOffset` — help overlay visibility and scroll
 *   - `shortcutsOverlayActive`, `shortcutsScrollOffset` — shortcuts overlay state
 *   - `nextPasteId`, `nextImageId` — monotonically increasing ID counters
 *   - `mouseDownRow`, `mouseDownCol` — drag-tracking coordinates
 *   - `contentWidth` — reflow width (semi-stable; synced at feed() entry only)
 *   - `selectionCallback` — current in-flight selection modal callback (nullable)
 *   - `requestRender` — swapped per-feed to a buffered version, restored after
 *
 * **Stable service handles** (set once at construction, never reallocated):
 *   - `commandRegistry`, `commandContext` — wired via setCommandRegistry() after
 *     construction; synced at feed() entry (not per-action) since no action changes them
 *   - `autocomplete` — wired after construction; synced at feed() entry
 *   - `inputHistory`, `conversationManager` — late-wired service handles; synced at
 *     feed() entry only since no in-feed action rewires them
 *   - `pasteRegistry`, `imageRegistry` — owned Maps, never replaced
 *   - `selectionModal`, `bookmarkModal`, `settingsModal`, `sessionPickerModal`,
 *     `profilePickerModal` — modal objects constructed once in InputHandler constructor
 *   - `filePicker`, `modelPicker`, `onboardingWizard`, `processModal`, `liveTailModal`,
 *     `agentDetailModal`, `contextInspectorModal`, `blockActionsMenu`, `searchManager`, `historySearch` —
 *     service objects constructed once
 *   - `panelManager`, `keybindingsManager` — from uiServices, stable for app lifetime
 *   - `modalStack` — reference to the handler's shared array (mutated in place)
 *   - `getHistory`, `getViewportHeight`, `getScrollTop`, `scroll`, `exitApp` — stable
 *     callbacks bound in the InputHandler constructor
 *   - All method closures (`modalOpened`, `handleEscape`, etc.) — bound once at init
 *
 * **Rationale:** per-feed mutation avoids per-keystroke allocation cost; stable
 * references are service handles whose identity never changes after construction.
 */
export interface InputFeedContext {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
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
  readonly projectRoot: string;
  readonly selection: SelectionManager;
  readonly selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  readonly bookmarkModal: BookmarkModal;
  readonly settingsModal: SettingsModal;
  readonly mcpWorkspace: McpWorkspace;
  readonly sessionPickerModal: SessionPickerModal;
  readonly profilePickerModal: ProfilePickerModal;
  readonly historySearch: HistorySearch;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  readonly filePicker: FilePickerModal;
  readonly modelPicker: ModelPickerModal;
  readonly onboardingWizard: OnboardingWizardController;
  readonly processModal: ProcessModal;
  readonly liveTailModal: LiveTailModal;
  readonly agentDetailModal: AgentDetailModal;
  readonly contextInspectorModal: ContextInspectorModal;
  readonly blockActionsMenu: BlockActionsMenu;
  readonly searchManager: SearchManager;
  readonly panelManager: PanelManager;
  panelMouseLayout: PanelMouseLayout | null;
  readonly keybindingsManager: KeybindingsManager;
  readonly modalStack: string[];
  inputHistory: InputHistory | null;
  conversationManager: ConversationManager | null;
  readonly killRing: KillRing;
  /** Terminal focus tracker (W2.3) — updated here from 'focus' tokens, read by the unfocused-alert notifiers in core/. */
  readonly focusTracker: FocusTracker;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  requestRender: () => void;
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
  /** Coalescing variant: consecutive text insertions within UNDO_COALESCE_MS merge into one group. */
  readonly saveUndoStateForText: () => void;
  /** Break the current coalescing group (cursor moves call this). */
  readonly breakUndoCoalesce: () => void;
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
  readonly expandPrompt: (text: string) => string | import('@pellux/goodvibes-sdk/platform/providers').ContentPart[];
  readonly openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  readonly openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  readonly onModelPickerCommit: () => boolean;
  readonly onOnboardingAction: (action: OnboardingWizardAction) => void;
  /** Called after any wizard step navigation so the handler can persist progress. */
  readonly onStepChange?: () => void;
  readonly exitApp: () => void;
}

export function feedInputTokens(context: InputFeedContext, tokens: readonly InputToken[]): void {
  const history = context.getHistory();
  const viewportHeight = context.getViewportHeight();
  const scrollTop = context.getScrollTop();
  const lineCount = history.getLineCount();
  const keybindings = context.keybindingsManager;

  // Shared opener for the Fleet panel: makes it visible AND transfers keyboard
  // focus to it. panelManager.open() only makes the panel active — focus is a
  // separate axis (see PanelManager.focusPanels()/getFocusTarget()); without the
  // focusPanels() call, j/k/i/K land silently in the composer until Tab. Used by
  // the footer indicator's [Enter] and by F2 (W6.2 e: F2 and the footer
  // indicator both subsume the retired process modal). Mirrors the Ctrl+P
  // panel-picker launcher (ui-openers.ts openPanelPicker).
  const openFleetPanel = (): void => {
    context.panelManager.open('fleet');
    context.panelManager.focusPanels();
    context.panelFocused = true;
  };

  // Paste-ness is a per-TOKEN property, computed at the handlePanelFocusToken
  // call below — never a per-feed character sum. The SDK tokenizer emits a
  // bracketed paste (\x1b[?2004h, enabled in main.ts terminal init) as ONE
  // 'text' token holding the whole payload, while discrete keystrokes — even
  // several batched into one feed() by render-tick latency — arrive as
  // separate 1-char 'text' tokens. The old per-feed sum misread two quick nav
  // keystrokes (e.g. j then k in one drain) as a "burst" and yanked focus.
  for (const token of tokens) {
    // Focus-reporting tokens (CSI ?1004h, W2.3) never reach the composer or any
    // modal route — consumed here, first, unconditionally. No render needed.
    if (token.type === 'focus') {
      context.focusTracker.setFocused(token.action === 'in');
      continue;
    }

    if (token.type === 'key' && context.keybindingsManager.matches('clear-cancel', token)) {
      context.handleCtrlC();
      continue;
    }

    const modalRoute = handleModalTokenRoutes({
      history,
      searchShortcutMatch: token.type === 'key' && keybindings.matches('search', token),
      selectionModal: context.selectionModal,
      selectionCallback: context.selectionCallback,
      getSelectionCallback: () => context.selectionCallback,
      setSelectionCallback: (callback) => {
        context.selectionCallback = callback;
      },
      bookmarkModal: context.bookmarkModal,
      settingsModal: context.settingsModal,
      mcpWorkspace: context.mcpWorkspace,
      sessionPickerModal: context.sessionPickerModal,
      profilePickerModal: context.profilePickerModal,
      onboardingWizard: context.onboardingWizard,
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
      openModelPickerWithTarget: context.openModelPickerWithTarget,
      openProviderModelPickerWithTarget: context.openProviderModelPickerWithTarget,
      onModelPickerCommit: context.onModelPickerCommit,
      onOnboardingAction: context.onOnboardingAction,
      onStepChange: context.onStepChange,
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
      // Focus can never disagree with workspace visibility: PanelManager owns
      // focusTarget and self-heals it, and context.panelFocused was seeded from
      // it at feed entry — so no manual "unfocus if panels vanished" patch is
      // needed here anymore.
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
        killRing: context.killRing,
      };
      if (handleGlobalShortcutToken(shortcutState, token, viewportHeight)) {
        context.prompt = shortcutState.prompt;
        context.cursorPos = shortcutState.cursorPos;
        context.commandMode = shortcutState.commandMode;
        context.panelFocused = shortcutState.panelFocused;
        if (context.commandMode) {
          if (!context.prompt.startsWith('/')) {
            context.commandMode = false;
            context.autocomplete?.reset();
          } else {
            const q = context.prompt.slice(1);
            if (q.indexOf(' ') === -1) {
              context.autocomplete?.update(q);
            } else {
              context.autocomplete?.reset();
            }
          }
        }
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
      // Per-token paste classification (Invariant B): a paste is a single
      // 'text' token whose value holds more than one character.
      isPasteToken: token.type === 'text' && token.value.length > 1,
      // One-shot honesty hint when a paste is dropped into a non-capturing
      // focused panel (Invariant A: focus never silently flips to the composer).
      onPasteDropped: (panelName: string) =>
        context.commandContext?.print(
          `paste ignored — focus is on ${panelName}; Tab returns to composer`,
        ),
      isTurnActive: () => context.commandContext?.isGenerating?.() ?? false,
      cancelGeneration: () => context.commandContext?.cancelGeneration?.(),
    }, token);
    context.panelFocused = panelRoute.panelFocused;
    if (panelRoute.handled) {
      continue;
    }

    const indicatorRoute = handleIndicatorFocusToken({
      indicatorFocused: context.indicatorFocused,
      modalOpened: context.modalOpened,
      openFleetPanel,
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
      saveUndoStateForText: context.saveUndoStateForText,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      registerPaste: context.registerPaste,
      requestRender: context.requestRender,
      killRing: context.killRing,
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
        panelFocused: context.panelFocused,
        panelManager: context.panelManager,
        conversationManager: context.conversationManager,
        requestRender: context.requestRender,
        handleEscape: context.handleEscape,
        projectRoot: context.projectRoot,
        pasteRegistry: context.pasteRegistry,
        imageRegistry: context.imageRegistry,
        nextPasteId: context.nextPasteId,
        nextImageId: context.nextImageId,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      };
      if (handleCommandModeToken(commandState, token)) {
        context.commandMode = commandState.commandMode;
        context.prompt = commandState.prompt;
        context.cursorPos = commandState.cursorPos;
        context.panelFocused = commandState.panelFocused;
        context.nextPasteId = commandState.nextPasteId;
        context.nextImageId = commandState.nextImageId;
        continue;
      }

      const keyRoute = handlePromptKeyToken({
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        inputScrollTop: context.inputScrollTop,
        commandMode: context.commandMode,
        contentWidth: context.contentWidth,
        maxInputRows: 8,
        inputHistory: context.inputHistory,
        indicatorFocused: context.indicatorFocused,
        conversationManager: context.conversationManager,
        commandContext: context.commandContext,
        commandRegistry: context.commandRegistry,
        autocomplete: context.autocomplete,
        blockActionsMenu: { open: (block: BlockMeta) => context.blockActionsMenu.open(block) },
        openFleetPanel,
        modalOpened: context.modalOpened,
        saveUndoState: context.saveUndoState,
        breakUndoCoalesce: context.breakUndoCoalesce,
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
        killRing: context.killRing,
      }, token);
      if (keyRoute.handled) {
        context.prompt = keyRoute.prompt;
        context.cursorPos = keyRoute.cursorPos;
        context.inputScrollTop = keyRoute.inputScrollTop;
        context.commandMode = keyRoute.commandMode;
        context.indicatorFocused = keyRoute.indicatorFocused;
        continue;
      }
    } else if (token.type === 'mouse') {
      const mouseRoute = handleMouseToken({
        conversationManager: context.conversationManager,
        selection: context.selection,
        panelManager: context.panelManager,
        panelMouseLayout: context.panelMouseLayout,
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
