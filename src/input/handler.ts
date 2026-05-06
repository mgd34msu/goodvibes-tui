import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core';
import { createOAuthLocalListener } from '@pellux/goodvibes-sdk/platform/config';
import { clearModalStackForHandler, cleanupMarkerRegistryForHandler, executeBlockActionForHandler, expandPromptForHandler, findMarkerAtPosForHandler, getImageAttachmentsForHandler, handleBlockCopyForHandler, handleBlockRerunForHandler, handleBlockSaveForHandler, handleBlockToggleForHandler, handleBookmarkForHandler, handleCopyForHandler, handleCtrlCForHandler, handleDiffApplyForHandler, handleEscapeForHandler, hydrateOnboardingWizardFromRuntimeForHandler, modalOpenedForHandler, openOnboardingWizardForHandler, registerPasteForHandler } from './handler-interactions.ts';
import { clearOnboardingModelPickerCancelStateForHandler, clearOnboardingPendingModelPickerTargetForHandler, completeOpenAiSubscriptionFromListenerForHandler, getOnboardingConfigValueForHandler, getOnboardingRuntimePostureForHandler, handleModelPickerCommitForHandler, handleOnboardingActionForHandler, handleOpenAiSubscriptionFinishForHandler, handleOpenAiSubscriptionStartForHandler, openModelPickerWithTargetForHandler, openProviderModelPickerWithTargetForHandler, refreshOnboardingHydrationForHandler, restartOnboardingExternalServicesIfNeededForHandler, restoreOnboardingModelPickerCancelStateForHandler, syncRuntimeFromOnboardingRequestForHandler, verifyOnboardingRuntimePostureForHandler, type OnboardingRuntimePosture } from './handler-onboarding.ts';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config';
import { openExternalUrl } from '@pellux/goodvibes-sdk/platform/utils';
import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import { SelectionManager } from './selection.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import { InputHistory, HistorySearch } from './input-history.ts';
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
import { OnboardingWizardController, type OnboardingWizardAction, type OnboardingWizardMode } from './onboarding/onboarding-wizard.ts';
import {
  applyOnboardingRequest,
  collectOnboardingSnapshot,
  getOnboardingCheckMarkerPath,
  verifyOnboardingRequest,
} from '../runtime/onboarding/index.ts';
import type {
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingShellPaths,
  OnboardingVerificationItem,
} from '../runtime/onboarding/index.ts';
import {
  IMAGE_EXTENSIONS,
  cleanupMarkerRegistry,
  expandPrompt,
  findMarkerAtPos,
  formatFileSize,
  handleBlockCopy,
  handleBlockRerun,
  handleBlockSave,
  handleBlockToggle,
  handleBookmark,
  handleClipboardPaste,
  handleCopy,
  handleCtrlC,
  handleDiffApply,
  mediaTypeFromExt,
  registerPaste,
} from './handler-content-actions.ts';
import {
  handleIndicatorFocusToken,
  handleMouseToken,
  handlePanelFocusToken,
  handlePromptKeyToken,
  handlePromptTextToken,
  type PanelMouseLayout,
} from './handler-feed-routes.ts';
import {
  ensureInputCursorVisible,
  findPathToken,
  getWrappedPromptInfo,
  handlePathCompletion,
  moveCursorVertical,
  redoPromptState,
  saveUndoState,
  undoPromptState,
  wordWrapLine,
  type WrappedPromptInfo,
} from './handler-prompt-buffer.ts';
import { clearModalStack, handleEscape, modalOpened } from './handler-modal-stack.ts';
import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import {
  captureOnboardingWizardSnapshot,
  handleHistorySearchToken,
  handleOverlayToken,
  openOnboardingWizardState,
  restoreOnboardingWizardSnapshot,
  handleSearchModeToken,
  type OnboardingWizardSnapshot,
  type OpenOnboardingWizardOptions,
} from './handler-ui-state.ts';
import {
  handleBookmarkModalToken,
  handleProfilePickerToken,
  handleSelectionModalToken,
  handleSessionPickerToken,
  handleSettingsModalToken,
} from './handler-modal-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import {
  handleBlockActionsToken,
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleLiveTailToken,
  handleModelPickerToken,
  handleProcessModalToken,
} from './handler-picker-routes.ts';
import { handleGlobalShortcutToken } from './handler-shortcuts.ts';
import { feedInputTokens } from './handler-feed.ts';
import { buildInitialFeedContext, syncFeedContextMutableFields } from './feed-context-factory.ts';
import { handlePanelIntegrationAction as runPanelIntegrationAction } from './panel-integration-actions.ts';
import type { Panel } from '../panels/types.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
export { handlePanelIntegrationAction } from './panel-integration-actions.ts';
import type { ModelPickerTarget } from './model-picker.ts';

type SelectionModalCallback = (result: SelectionResult | null) => void;


/**
 * InputHandler - Owns prompt text, paste registry, and keyboard/mouse handling.
 * Extracted from main.ts and StateManager.
 */
export class InputHandler {
  public prompt = '';
  public cursorPos = 0;
  public showExitNotice = false;
  /** Max visible rows for the input area. Content beyond this scrolls internally. */
  public static readonly MAX_INPUT_ROWS = 8;
  /** Internal scroll offset for the input area when content exceeds MAX_INPUT_ROWS. */
  public inputScrollTop = 0;
  public lastCopyTime = 0;
  /** True when the user has entered slash-command mode (prompt starts with '/'). */
  public commandMode = false;
  /** True when the process indicator bar has keyboard focus. */
  public indicatorFocused = false;
  /** True when keyboard focus is on the active panel (arrow/enter go to panel, not prompt). */
  public panelFocused = false;

  public tokenizer = new InputTokenizer();
  public pasteRegistry = new Map<string, string>();
  public nextPasteId = 1;
  public lastCtrlCTime = 0;
  /** Long-lived feed context — reused across every feed() call to avoid per-keystroke allocation. */
  public feedContext!: import('./handler-feed.ts').InputFeedContext;
  public commandRegistry: CommandRegistry | null = null;
  public commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public modelPicker: ModelPickerModal;
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public processModal: ProcessModal;
  public liveTailModal: LiveTailModal;
  public agentDetailModal: AgentDetailModal;
  public contextInspectorModal = new ContextInspectorModal();
  public bookmarkModal: BookmarkModal;
  public blockActionsMenu = new BlockActionsMenu();
  public settingsModal = new SettingsModal();
  public onboardingWizard = new OnboardingWizardController();
  public onboardingModelPickerCancelSnapshot: OnboardingWizardSnapshot | null = null;
  public onboardingHydrationSerial = 0;
  public onboardingApplyPending = false;
  public onboardingOpenAiListenerSerial = 0;

  /**
   * Modal navigation stack. Each element is the name of an open modal.
   * Used to support back-navigation via Escape.
   */
  public modalStack: string[] = [];
  public modalReturnFocus: 'prompt' | 'panel' | 'indicator' = 'prompt';
  public sessionPickerModal: SessionPickerModal;
  public profilePickerModal: ProfilePickerModal;
  /** True when the help overlay is visible. */
  public helpOverlayActive = false;
  public helpScrollOffset = 0;
  public shortcutsOverlayActive = false;
  public shortcutsScrollOffset = 0;
  public inputHistory: InputHistory | null = null;
  public filePicker: FilePickerModal;
  public historySearch: HistorySearch = new HistorySearch(() => this.inputHistory?.getEntries() ?? []);
  public conversationManager: ConversationManager | null = null;
  public selectionCallback: SelectionModalCallback | null = null;
  public syncFeedSelectionCallback: ((callback: SelectionModalCallback | null) => void) | null = null;
  /** Time of last [COPIED] block feedback, for brief display. */
  public lastBlockCopyTime = 0;
  public mouseDownRow = -1;
  public mouseDownCol = -1;

  /** Pasted images: maps marker IDs to base64 image data. */
  public imageRegistry = new Map<string, { data: string; mediaType: string }>();
  public nextImageId = 1;

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  public undoStack: Array<{ prompt: string; cursorPos: number }> = [];
  public redoStack: Array<{ prompt: string; cursorPos: number }> = [];
  public static readonly MAX_UNDO = 50;

  // ── Path completion (Tab on path-like token) ───────────────────────────────
  /** Current list of path completions cycling on repeated Tab presses. */
  public pathCompletions: string[] = [];
  /** Index into pathCompletions for Tab cycling. */
  public pathCompletionIndex = -1;
  /** The raw prefix that triggered path completion (e.g. 'src/in'). */
  public pathCompletionPrefix = '';
  /** Start offset in prompt where the path token begins. */
  public pathCompletionStart = 0;

  constructor(
    public requestRender: () => void,
    public selection: SelectionManager,
    public getScrollTop: () => number,
    public getViewportHeight: () => number,
    public getHistory: () => InfiniteBuffer,
    public scroll: (delta: number) => void,
    public exitApp: () => void,
    public readonly uiServices: Pick<UiRuntimeServices,
      'agents'
      | 'environment'
      | 'platform'
      | 'providers'
      | 'sessions'
      | 'shell'
    >,
  ) {
    this.filePicker = new FilePickerModal(uiServices.environment.shellPaths);
    this.modelPicker = new ModelPickerModal(
      uiServices.providers.favoritesStore,
      uiServices.providers.benchmarkStore,
      uiServices.providers.providerRegistry,
    );
    this.processModal = new ProcessModal({
      agentManager: uiServices.agents.agentManager,
      processManager: uiServices.shell.processManager,
      wrfcController: uiServices.agents.wrfcController,
    });
    this.liveTailModal = new LiveTailModal({
      agentManager: uiServices.agents.agentManager,
      processManager: uiServices.shell.processManager,
    });
    this.agentDetailModal = new AgentDetailModal({
      agentManager: uiServices.agents.agentManager,
      agentMessageBus: uiServices.agents.agentMessageBus,
      sessionLogPathResolver: (agentId) => uiServices.environment.shellPaths.resolveProjectPath('tui', 'sessions', `${agentId}.jsonl`),
      // SDK 0.23.0: supply wrfcController so the modal can show constraint data
      wrfcController: uiServices.agents.wrfcController,
    });
    this.bookmarkModal = new BookmarkModal(uiServices.shell.bookmarkManager);
    this.sessionPickerModal = new SessionPickerModal(uiServices.sessions.sessionManager);
    this.profilePickerModal = new ProfilePickerModal(uiServices.shell.profileManager);
    this.initFeedContext();
  }

  /**
   * initFeedContext — Build the long-lived InputFeedContext once via factory.
   * See feed-context-factory.ts for full field documentation.
   */
  public initFeedContext(): void {
    this.feedContext = buildInitialFeedContext(
      {
        prompt: this.prompt, cursorPos: this.cursorPos, commandMode: this.commandMode,
        panelFocused: this.panelFocused, indicatorFocused: this.indicatorFocused,
        helpOverlayActive: this.helpOverlayActive, helpScrollOffset: this.helpScrollOffset,
        shortcutsOverlayActive: this.shortcutsOverlayActive, shortcutsScrollOffset: this.shortcutsScrollOffset,
        nextPasteId: this.nextPasteId, nextImageId: this.nextImageId,
        mouseDownRow: this.mouseDownRow, mouseDownCol: this.mouseDownCol,
        contentWidth: this.contentWidth, panelMouseLayout: this.panelMouseLayout,
        selectionCallback: this.selectionCallback,
      },
      {
        selection: this.selection,
        pasteRegistry: this.pasteRegistry,
        imageRegistry: this.imageRegistry,
        selectionModal: this.selectionModal,
        bookmarkModal: this.bookmarkModal,
        settingsModal: this.settingsModal,
        sessionPickerModal: this.sessionPickerModal,
        profilePickerModal: this.profilePickerModal,
        historySearch: this.historySearch,
        commandRegistry: this.commandRegistry,
        commandContext: this.commandContext,
        autocomplete: this.autocomplete,
        filePicker: this.filePicker,
        modelPicker: this.modelPicker,
        onboardingWizard: this.onboardingWizard,
        processModal: this.processModal,
        liveTailModal: this.liveTailModal,
        agentDetailModal: this.agentDetailModal,
        contextInspectorModal: this.contextInspectorModal,
        blockActionsMenu: this.blockActionsMenu,
        searchManager: this.searchManager,
        modalStack: this.modalStack,
        inputHistory: this.inputHistory,
        conversationManager: this.conversationManager,
        panelManager: this.uiServices.shell.panelManager,
        keybindingsManager: this.uiServices.shell.keybindingsManager,
        getHistory: this.getHistory,
        getViewportHeight: this.getViewportHeight,
        getScrollTop: this.getScrollTop,
        scroll: this.scroll,
        exitApp: this.exitApp,
      },
      {
        modalOpened: (name: string) => this.modalOpened(name),
        handleEscape: () => { this.handleEscape(); this.syncFeedContextMutableFields(); },
        handleCopy: () => this.handleCopy(),
        handleCtrlC: () => { this.handleCtrlC(); this.syncFeedContextMutableFields(); },
        handleBlockCopy: () => this.handleBlockCopy(),
        handleBookmark: () => this.handleBookmark(),
        handleBlockSave: () => this.handleBlockSave(),
        handleDiffApply: () => this.handleDiffApply(),
        handleUndo: () => { this.handleUndo(); this.syncFeedContextMutableFields(); },
        handleRedo: () => { this.handleRedo(); this.syncFeedContextMutableFields(); },
        handlePaste: () => { this.handlePaste(); this.syncFeedContextMutableFields(); },
        saveUndoState: () => this.saveUndoState(),
        ensureInputCursorVisible: (contentWidth?: number) => this.ensureInputCursorVisible(contentWidth),
        registerPaste: (content: string) => this.registerPaste(content),
        executeBlockAction: (id: string) => this.executeBlockAction(id),
        cyclePanelTab: (direction: 'next' | 'prev') => this.cyclePanelTab(direction),
        onPanelInputConsumed: (activePanel: Panel | null, key: string) => this.handlePanelIntegrationAction(activePanel, key),
        getWrappedPromptInfo: (contentWidth: number) => this.getWrappedPromptInfo(contentWidth),
        moveCursorVertical: (direction: -1 | 1) => this.moveCursorVertical(direction),
        handlePathCompletion: () => this.handlePathCompletion(),
        handleBlockToggle: () => this.handleBlockToggle(),
        findMarkerAtPos: (pos: number) => this.findMarkerAtPos(pos),
        cleanupMarkerRegistry: (text: string) => this.cleanupMarkerRegistry(text),
        expandPrompt: (text: string) => this.expandPrompt(text),
        openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') =>
          this.openModelPickerWithTarget(target, source),
        openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') =>
          this.openProviderModelPickerWithTarget(target, source),
        onModelPickerCommit: () => this.handleModelPickerCommit(),
        onOnboardingAction: (action: OnboardingWizardAction) => { void this.handleOnboardingAction(action); },
      },
    );
  }

  /** Sync mutable handler fields back into feedContext after in-feed mutations. */
  public syncFeedContextMutableFields(): void {
    const h = this;
    syncFeedContextMutableFields({ prompt: h.prompt, cursorPos: h.cursorPos, commandMode: h.commandMode,
      panelFocused: h.panelFocused, indicatorFocused: h.indicatorFocused, helpOverlayActive: h.helpOverlayActive,
      helpScrollOffset: h.helpScrollOffset, shortcutsOverlayActive: h.shortcutsOverlayActive,
      shortcutsScrollOffset: h.shortcutsScrollOffset, selectionCallback: h.selectionCallback,
      nextPasteId: h.nextPasteId, nextImageId: h.nextImageId, mouseDownRow: h.mouseDownRow,
      mouseDownCol: h.mouseDownCol, contentWidth: h.contentWidth,
      panelMouseLayout: h.panelMouseLayout }, this.feedContext);
  }

  /** Wire in the InputHistory instance. Optional; disables history navigation if unset. */
  public setHistory(history: InputHistory): void { this.inputHistory = history; }

  /** Wire in the slash command registry and context. Must be called before commands work. */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    this.autocomplete = new AutocompleteEngine(registry);
  }

  /** Wire in the conversation manager for block copy/apply/collapse. */
  public setConversationManager(cm: ConversationManager): void { this.conversationManager = cm; }

  /**
   * openSelection - Open the generic selection modal with a callback.
   * The callback receives SelectionResult on selection, or null on cancel/escape.
   */
  public openSelection(
    title: string,
    items: import('./selection-modal.ts').SelectionItem[],
    opts: {
      preSelectId?: string;
      allowSearch?: boolean;
      customActions?: Map<string, SelectionAction>;
    } | undefined,
    callback: SelectionModalCallback,
  ): void {
    this.modalOpened('selection');
    this.selectionModal.open(title, items, opts);
    this.selectionCallback = callback;
    this.syncFeedSelectionCallback?.(callback);
    this.requestRender();
  }


  public openOnboardingWizard(
    modeOrOptions: OnboardingWizardMode | OpenOnboardingWizardOptions = 'new',
  ): void { openOnboardingWizardForHandler(this, modeOrOptions); }

  public async hydrateOnboardingWizardFromRuntime(hydrationSerial: number): Promise<void> { await hydrateOnboardingWizardFromRuntimeForHandler(this, hydrationSerial); }
  public registerPaste(content: string): string { return registerPasteForHandler(this, content); }
  public expandPrompt(text: string) { return expandPromptForHandler(this, text); }
  public getImageAttachments(): Map<string, { data: string; mediaType: string }> { return getImageAttachmentsForHandler(this); }
  public cleanupMarkerRegistry(markerText: string): void { cleanupMarkerRegistryForHandler(this, markerText); }
  public findMarkerAtPos(pos: number): { start: number; end: number } | null { return findMarkerAtPosForHandler(this, pos); }
  public handleCopy(): void { handleCopyForHandler(this); }
  public handleBlockCopy(): void { handleBlockCopyForHandler(this); }
  public handleBookmark(): void { handleBookmarkForHandler(this); }
  public handleBlockSave(): void { handleBlockSaveForHandler(this); }
  public executeBlockAction(actionId: string): void { executeBlockActionForHandler(this, actionId); }
  public handleBlockRerun(): void { handleBlockRerunForHandler(this); }
  public handleBlockToggle(): void { handleBlockToggleForHandler(this); }
  public handleDiffApply(): boolean { return handleDiffApplyForHandler(this); }
  public handleCtrlC(): void { handleCtrlCForHandler(this); }
  public modalOpened(name: string): void { modalOpenedForHandler(this, name); }
  public clearModalStack(): void { clearModalStackForHandler(this); }
  public handleEscape(): void { handleEscapeForHandler(this); }

  public clearOnboardingPendingModelPickerTarget(): void { clearOnboardingPendingModelPickerTargetForHandler(this); }
  public clearOnboardingModelPickerCancelState(): void { clearOnboardingModelPickerCancelStateForHandler(this); }
  public restoreOnboardingModelPickerCancelState(): void { restoreOnboardingModelPickerCancelStateForHandler(this); }
  public openModelPickerWithTarget(target: ModelPickerTarget, source: 'settings' | 'onboarding' = 'settings'): boolean { return openModelPickerWithTargetForHandler(this, target, source); }
  public openProviderModelPickerWithTarget(target: ModelPickerTarget, source: 'settings' | 'onboarding' = 'settings'): boolean { return openProviderModelPickerWithTargetForHandler(this, target, source); }
  public handleModelPickerCommit(): boolean { return handleModelPickerCommitForHandler(this); }
  public async handleOnboardingAction(action: OnboardingWizardAction): Promise<void> { await handleOnboardingActionForHandler(this, action); }
  public async refreshOnboardingHydration(options: { readonly preserveValues?: boolean; readonly targetStepId?: string } = {}): Promise<void> { await refreshOnboardingHydrationForHandler(this, options); }
  public async handleOpenAiSubscriptionStart(): Promise<void> { await handleOpenAiSubscriptionStartForHandler(this); }
  public async completeOpenAiSubscriptionFromListener(listener: Awaited<ReturnType<typeof createOAuthLocalListener>>, verifier: string, serial: number): Promise<void> { await completeOpenAiSubscriptionFromListenerForHandler(this, listener, verifier, serial); }
  public async handleOpenAiSubscriptionFinish(): Promise<void> { await handleOpenAiSubscriptionFinishForHandler(this); }
  public syncRuntimeFromOnboardingRequest(request: ReturnType<OnboardingWizardController['buildApplyRequest']>): void { syncRuntimeFromOnboardingRequestForHandler(this, request); }
  public getOnboardingConfigValue(request: OnboardingApplyRequest, key: string): unknown { return getOnboardingConfigValueForHandler(this, request, key); }
  public getOnboardingRuntimePosture(request: OnboardingApplyRequest): OnboardingRuntimePosture { return getOnboardingRuntimePostureForHandler(this, request); }
  public async restartOnboardingExternalServicesIfNeeded(request: OnboardingApplyRequest): Promise<OnboardingVerificationItem[]> { return await restartOnboardingExternalServicesIfNeededForHandler(this, request); }
  public verifyOnboardingRuntimePosture(request: OnboardingApplyRequest): OnboardingVerificationItem[] { return verifyOnboardingRuntimePostureForHandler(this, request); }


  /**
   * feed - Process raw stdin data through the tokenizer.
   * Reuses the long-lived this.feedContext to avoid per-keystroke object allocation.
   */
  public feed(data: string): void {
    const immediateRequestRender = this.requestRender;
    let renderRequested = false;
    let isFeeding = true;
    const bufferedRequestRender = (): void => {
      if (isFeeding) {
        renderRequested = true;
        return;
      }
      immediateRequestRender();
    };

    this.requestRender = bufferedRequestRender;
    try {
      const context = this.feedContext;
      // Sync mutable scalars from handler into the reused context.
      context.prompt = this.prompt;
      context.cursorPos = this.cursorPos;
      context.commandMode = this.commandMode;
      context.panelFocused = this.panelFocused;
      context.indicatorFocused = this.indicatorFocused;
      context.helpOverlayActive = this.helpOverlayActive;
      context.helpScrollOffset = this.helpScrollOffset;
      context.shortcutsOverlayActive = this.shortcutsOverlayActive;
      context.shortcutsScrollOffset = this.shortcutsScrollOffset;
      context.selectionCallback = this.selectionCallback;
      context.nextPasteId = this.nextPasteId;
      context.nextImageId = this.nextImageId;
      context.mouseDownRow = this.mouseDownRow;
      context.mouseDownCol = this.mouseDownCol;
      context.contentWidth = this.contentWidth;
      context.panelMouseLayout = this.panelMouseLayout;
      // Sync semi-stable refs that may be wired after construction.
      context.commandRegistry = this.commandRegistry;
      context.commandContext = this.commandContext;
      context.autocomplete = this.autocomplete;
      context.inputHistory = this.inputHistory;
      context.conversationManager = this.conversationManager;
      // Swap requestRender to buffered version for this feed.
      context.requestRender = bufferedRequestRender;
      this.syncFeedSelectionCallback = (callback) => {
        context.selectionCallback = callback;
      };
      feedInputTokens(context, this.tokenizer.feed(data));
      this.prompt = context.prompt;
      this.cursorPos = context.cursorPos;
      this.commandMode = context.commandMode;
      this.panelFocused = context.panelFocused;
      this.indicatorFocused = context.indicatorFocused;
      this.helpOverlayActive = context.helpOverlayActive;
      this.helpScrollOffset = context.helpScrollOffset;
      this.shortcutsOverlayActive = context.shortcutsOverlayActive;
      this.shortcutsScrollOffset = context.shortcutsScrollOffset;
      this.selectionCallback = context.selectionCallback;
      this.nextPasteId = context.nextPasteId;
      this.nextImageId = context.nextImageId;
      this.mouseDownRow = context.mouseDownRow;
      this.mouseDownCol = context.mouseDownCol;
    } finally {
      this.syncFeedSelectionCallback = null;
      isFeeding = false;
      this.requestRender = immediateRequestRender;
    }

    if (renderRequested) {
      immediateRequestRender();
    }
  }

  /**
   * handlePaste - Shared paste logic for Ctrl+V and middle-click.
   * Tries image clipboard first, falls back to text paste.
   */
  public handlePaste(): void {
    const result = handleClipboardPaste({
      prompt: this.prompt,
      cursorPos: this.cursorPos,
      pasteRegistry: this.pasteRegistry,
      nextPasteId: this.nextPasteId,
      imageRegistry: this.imageRegistry,
      nextImageId: this.nextImageId,
      saveUndoState: () => this.saveUndoState(),
      ensureInputCursorVisible: () => this.ensureInputCursorVisible(),
      requestRender: this.requestRender,
    }, this.uiServices.environment.shellPaths.workingDirectory);
    this.prompt = result.prompt;
    this.cursorPos = result.cursorPos;
    this.nextImageId = result.nextImageId;
    this.nextPasteId = result.nextPasteId;
  }

  /** Content width for wrapping — set by main.ts via setContentWidth(). */
  public contentWidth = 76;
  public panelMouseLayout: PanelMouseLayout | null = null;

  /** Set the content width used for wrapping calculations. Call from main.ts. */
  public setContentWidth(w: number): void {
    this.contentWidth = w;
  }

  public setPanelMouseLayout(layout: PanelMouseLayout | null): void {
    this.panelMouseLayout = layout;
  }

  /**
   * Move cursor up or down by one WRAPPED line.
   * Uses the segment table to navigate visual lines, not raw \n lines.
   * Returns true if the cursor moved, false if at boundary.
   */
  public moveCursorVertical(direction: -1 | 1): boolean {
    const result = moveCursorVertical(
      this.prompt,
      this.cursorPos,
      this.inputScrollTop,
      this.contentWidth,
      InputHandler.MAX_INPUT_ROWS,
      direction,
    );
    this.cursorPos = result.cursorPos;
    this.inputScrollTop = result.inputScrollTop;
    return result.moved;
  }

  /**
   * Ensure the cursor's wrapped line is visible within the input scroll window.
   */
  public ensureInputCursorVisible(contentWidth?: number): void {
    this.inputScrollTop = ensureInputCursorVisible(
      this.prompt,
      this.cursorPos,
      this.inputScrollTop,
      contentWidth ?? this.contentWidth,
      InputHandler.MAX_INPUT_ROWS,
    );
  }

  /**
   * Get the number of visible prompt lines (capped at MAX_INPUT_ROWS),
   * accounting for word-wrapping within the content width.
   */
  public getVisiblePromptLineCount(contentWidth?: number): number {
    const info = this.getWrappedPromptInfo(contentWidth ?? 76);
    return Math.min(info.wrappedLines.length, InputHandler.MAX_INPUT_ROWS);
  }

  /**
   * Word-wrap the prompt and compute cursor display coordinates.
   * Returns wrapped lines, the cursor's position in wrapped coordinates,
   * and the visible slice respecting inputScrollTop.
   */
  public getWrappedPromptInfo(contentWidth: number): WrappedPromptInfo {
    return getWrappedPromptInfo(
      this.prompt,
      this.cursorPos,
      this.inputScrollTop,
      contentWidth,
      InputHandler.MAX_INPUT_ROWS,
    );
  }

  // ── Undo / Redo methods ─────────────────────────────────────────────────

  /**
   * saveUndoState - Snapshot current prompt + cursor onto the undo stack.
   * Clears the redo stack because a new edit invalidates future states.
   */
  public saveUndoState(): void {
    saveUndoState(this.undoStack, this.redoStack, this.prompt, this.cursorPos, InputHandler.MAX_UNDO);
  }

  /**
   * handleUndo - Ctrl+Z: pop from undo stack, push current to redo stack.
   */
  public handleUndo(): void {
    const state = undoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  /**
   * handleRedo - Ctrl+Shift+Z: pop from redo stack, push current to undo stack.
   */
  public handleRedo(): void {
    const state = redoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  // ── Path completion methods ─────────────────────────────────────────────

  /**
   * findPathToken - Scan backward from cursor to find a path-like token.
   * Detects:
   *   - !@<partial>  (inject mode)
   *   - @<partial>   (normal file ref)
   *   - plain word containing '/'
   * Returns { start, prefix } or null if no path token found.
   */
  /**
   * handlePathCompletion - Tab on a path-like token: fuzzy-complete from filePicker.allFiles.
   * Repeated Tab cycles through matches.
   * Returns true if path completion was performed.
   */
  public findPathToken(): { start: number; prefix: string } | null {
    return findPathToken(this.prompt, this.cursorPos);
  }

  public handlePathCompletion(): boolean {
    const result = handlePathCompletion({
      prompt: this.prompt,
      cursorPos: this.cursorPos,
      inputScrollTop: this.inputScrollTop,
      contentWidth: this.contentWidth,
      maxRows: InputHandler.MAX_INPUT_ROWS,
      pathCompletions: this.pathCompletions,
      pathCompletionIndex: this.pathCompletionIndex,
      pathCompletionPrefix: this.pathCompletionPrefix,
      pathCompletionStart: this.pathCompletionStart,
      allFiles: this.filePicker.allFiles,
      saveUndoState: () => this.saveUndoState(),
    });
    if (!result.handled) return false;
    this.prompt = result.prompt;
    this.cursorPos = result.cursorPos;
    this.inputScrollTop = result.inputScrollTop;
    this.pathCompletions = result.pathCompletions;
    this.pathCompletionIndex = result.pathCompletionIndex;
    this.pathCompletionPrefix = result.pathCompletionPrefix;
    this.pathCompletionStart = result.pathCompletionStart;
    return true;
  }

  /**
   * Word-wrap a single line to fit within maxW columns.
   * Breaks at spaces; words wider than maxW are force-broken.
   */
  public cyclePanelTab(direction: 'next' | 'prev'): void {
    const pm = this.uiServices.shell.panelManager;
    if (pm.isVisible()) {
      if (direction === 'next') pm.nextWorkspaceTab();
      else pm.prevWorkspaceTab();
      this.requestRender();
    }
  }

  public handlePanelIntegrationAction(activePanel: Panel | null, key: string): void {
    runPanelIntegrationAction(this.uiServices.shell.panelManager, activePanel, key, this.commandContext);
  }

  public wordWrapLine(line: string, maxW: number): string[] {
    return wordWrapLine(line, maxW);
  }
}
