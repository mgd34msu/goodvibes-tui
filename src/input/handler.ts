import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core/tokenizer';
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
  handleHistorySearchToken,
  handleOverlayToken,
  handleSearchModeToken,
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
import { handlePanelIntegrationAction as runPanelIntegrationAction } from './panel-integration-actions.ts';
import type { Panel } from '../panels/types.ts';
import type { UiRuntimeServices } from '../runtime/ui-services.ts';
export { handlePanelIntegrationAction } from './panel-integration-actions.ts';

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

  private tokenizer = new InputTokenizer();
  private pasteRegistry = new Map<string, string>();
  private nextPasteId = 1;
  private lastCtrlCTime = 0;
  /** Long-lived feed context — reused across every feed() call to avoid per-keystroke allocation. */
  private feedContext!: import('./handler-feed.ts').InputFeedContext;
  private commandRegistry: CommandRegistry | null = null;
  private commandContext: CommandContext | undefined = undefined;
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
  private inputHistory: InputHistory | null = null;
  public filePicker: FilePickerModal;
  public historySearch: HistorySearch = new HistorySearch(() => this.inputHistory?.getEntries() ?? []);
  private conversationManager: ConversationManager | null = null;
  private selectionCallback: SelectionModalCallback | null = null;
  private syncFeedSelectionCallback: ((callback: SelectionModalCallback | null) => void) | null = null;
  /** Time of last [COPIED] block feedback, for brief display. */
  public lastBlockCopyTime = 0;
  private mouseDownRow = -1;
  private mouseDownCol = -1;

  /** Pasted images: maps marker IDs to base64 image data. */
  private imageRegistry = new Map<string, { data: string; mediaType: string }>();
  private nextImageId = 1;

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  private undoStack: Array<{ prompt: string; cursorPos: number }> = [];
  private redoStack: Array<{ prompt: string; cursorPos: number }> = [];
  private static readonly MAX_UNDO = 50;

  // ── Path completion (Tab on path-like token) ───────────────────────────────
  /** Current list of path completions cycling on repeated Tab presses. */
  private pathCompletions: string[] = [];
  /** Index into pathCompletions for Tab cycling. */
  private pathCompletionIndex = -1;
  /** The raw prefix that triggered path completion (e.g. 'src/in'). */
  private pathCompletionPrefix = '';
  /** Start offset in prompt where the path token begins. */
  private pathCompletionStart = 0;

  constructor(
    private requestRender: () => void,
    private selection: SelectionManager,
    private getScrollTop: () => number,
    private getViewportHeight: () => number,
    private getHistory: () => InfiniteBuffer,
    private scroll: (delta: number) => void,
    private exitApp: () => void,
    private readonly uiServices: Pick<UiRuntimeServices,
      'agents'
      | 'environment'
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
    });
    this.bookmarkModal = new BookmarkModal(uiServices.shell.bookmarkManager);
    this.sessionPickerModal = new SessionPickerModal(uiServices.sessions.sessionManager);
    this.profilePickerModal = new ProfilePickerModal(uiServices.shell.profileManager);
    this.initFeedContext();
  }

  /**
   * initFeedContext — Build the long-lived InputFeedContext once.
   * Stable (readonly) fields are set here and never reallocated.
   * Mutable scalar fields are synced at the top of every feed() call.
   */
  private initFeedContext(): void {
    // Placeholder requestRender — will be swapped to bufferedRequestRender inside feed().
    const noop = (): void => {};
    this.feedContext = {
      // --- mutable scalars (synced per feed) ---
      prompt: this.prompt,
      cursorPos: this.cursorPos,
      commandMode: this.commandMode,
      panelFocused: this.panelFocused,
      indicatorFocused: this.indicatorFocused,
      helpOverlayActive: this.helpOverlayActive,
      helpScrollOffset: this.helpScrollOffset,
      shortcutsOverlayActive: this.shortcutsOverlayActive,
      shortcutsScrollOffset: this.shortcutsScrollOffset,
      nextPasteId: this.nextPasteId,
      nextImageId: this.nextImageId,
      mouseDownRow: this.mouseDownRow,
      mouseDownCol: this.mouseDownCol,
      contentWidth: this.contentWidth,
      selectionCallback: this.selectionCallback,
      // --- requestRender: swapped per-feed to buffered version ---
      requestRender: noop,
      // --- stable readonly refs ---
      pasteRegistry: this.pasteRegistry,
      imageRegistry: this.imageRegistry,
      selection: this.selection,
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
      // --- stable bound-method closures ---
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
    };
  }

  /**
   * syncFeedContextMutableFields — Copy mutable InputHandler scalar fields back into feedContext.
   * Called from within action closures that mutate handler state during a feed.
   */
  private syncFeedContextMutableFields(): void {
    const ctx = this.feedContext;
    ctx.prompt = this.prompt;
    ctx.cursorPos = this.cursorPos;
    ctx.commandMode = this.commandMode;
    ctx.panelFocused = this.panelFocused;
    ctx.indicatorFocused = this.indicatorFocused;
    ctx.helpOverlayActive = this.helpOverlayActive;
    ctx.helpScrollOffset = this.helpScrollOffset;
    ctx.shortcutsOverlayActive = this.shortcutsOverlayActive;
    ctx.shortcutsScrollOffset = this.shortcutsScrollOffset;
    ctx.selectionCallback = this.selectionCallback;
    ctx.nextPasteId = this.nextPasteId;
    ctx.nextImageId = this.nextImageId;
    ctx.mouseDownRow = this.mouseDownRow;
    ctx.mouseDownCol = this.mouseDownCol;
  }

  /**
   * setHistory - Wire in the InputHistory instance.
   * Optional; if not set, history navigation is disabled.
   */
  public setHistory(history: InputHistory): void {
    this.inputHistory = history;
  }

  /**
   * setCommandRegistry - Wire in the slash command registry and context.
   * Must be called before commands can be processed.
   */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    this.autocomplete = new AutocompleteEngine(registry);
  }

  /**
   * setConversationManager - Wire in the conversation manager for block copy/apply/collapse.
   */
  public setConversationManager(cm: ConversationManager): void {
    this.conversationManager = cm;
  }

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

  public registerPaste(content: string): string {
    const result = registerPaste({
      pasteRegistry: this.pasteRegistry,
      nextPasteId: this.nextPasteId,
      imageRegistry: this.imageRegistry,
      nextImageId: this.nextImageId,
    }, content, this.uiServices.environment.shellPaths.workingDirectory);
    this.nextPasteId = result.nextPasteId;
    this.nextImageId = result.nextImageId;
    return result.marker;
  }

  /**
   * expandPrompt - Replaces paste markers with actual content.
   * If image markers are present, returns ContentPart[] for multimodal delivery.
   * Otherwise returns a plain string.
   */
  private expandPrompt(text: string) {
    return expandPrompt(this.pasteRegistry, this.imageRegistry, text, this.uiServices.environment.shellPaths.workingDirectory);
  }

  /**
   * getImageAttachments - Returns a copy of the current image registry.
   * Callers can use this to attach images when building LLM messages.
   */
  public getImageAttachments(): Map<string, { data: string; mediaType: string }> {
    return new Map(this.imageRegistry);
  }

  /**
   * findMarkerAtPos - Returns the start/end of an atomic marker if pos is inside one.
   * Used to make backspace/delete/arrow treat markers as single units.
   */
  /**
   * cleanupMarkerRegistry - If the given marker text is an IMAGE marker,
   * parses its ID and removes it from imageRegistry.
   */
  private cleanupMarkerRegistry(markerText: string): void {
    cleanupMarkerRegistry(this.imageRegistry, markerText);
  }

  private findMarkerAtPos(pos: number): { start: number; end: number } | null {
    return findMarkerAtPos(this.prompt, pos);
  }

  private handleCopy(): void {
    handleCopy(this.selection, this.getHistory, this.requestRender, () => {
      this.lastCopyTime = Date.now();
    });
  }

  /**
   * handleBlockCopy - Ctrl+Y: Copy the content of the nearest code/tool block.
   */
  private handleBlockCopy(): void {
    handleBlockCopy(this.conversationManager, this.getScrollTop, this.requestRender, () => {
      this.lastBlockCopyTime = Date.now();
    });
  }

  /**
   * handleBookmark - Ctrl+B: Toggle bookmark on the nearest block.
   */
  private handleBookmark(): void {
    handleBookmark(this.conversationManager, this.getScrollTop, this.requestRender, this.uiServices.shell.bookmarkManager);
  }

  /**
   * handleBlockSave - Ctrl+S: Save nearest block content to a file.
   */
  private handleBlockSave(): void {
    handleBlockSave(this.conversationManager, this.getScrollTop, this.requestRender, this.uiServices.shell.bookmarkManager);
  }

  /**
   * executeBlockAction - Execute a block action ID on the nearest block.
   * Called when the user selects an action from the BlockActionsMenu.
   */
  private executeBlockAction(actionId: string): void {
    switch (actionId) {
      case 'copy':     this.handleBlockCopy(); break;
      case 'bookmark': this.handleBookmark(); break;
      case 'toggle':   this.handleBlockToggle(); break;
      case 'apply':    this.handleDiffApply(); break;
      case 'rerun':    this.handleBlockRerun(); break;
    }
  }

  /**
   * handleBlockRerun - Re-run the tool call for the nearest tool block.
   * Emits a tool-rerun event for the orchestrator to handle.
   */
  private handleBlockRerun(): void {
    handleBlockRerun(this.conversationManager, this.getScrollTop, this.requestRender);
  }

  /**
   * handleBlockToggle - Tab (non-command mode): Toggle collapse of nearest block.
   */
  private handleBlockToggle(): void {
    handleBlockToggle(this.conversationManager, this.getScrollTop, this.requestRender);
  }

  /**
   * handleDiffApply - Ctrl+A when a diff block is nearest: request approval and apply the diff.
   * Returns true if a diff was found and applied (so caller can skip default Ctrl+A).
   */
  private handleDiffApply(): boolean {
    return handleDiffApply(
      this.conversationManager,
      this.getScrollTop,
      this.commandContext,
      this.requestRender,
      () => `diff-apply-${Date.now()}`,
      'write',
    );
  }

  /**
   * Handle Ctrl+C:
   * - If prompt has text: clear it
   * - If prompt is empty and LLM is thinking: cancel generation
   * - If prompt is empty and idle: show exit notice (double = exit)
   */
  private handleCtrlC(): void {
    handleCtrlC(
      this.prompt,
      () => this.saveUndoState(),
      (value) => { this.prompt = value; },
      (value) => { this.cursorPos = value; },
      this.commandContext?.cancelGeneration,
      this.exitApp,
      this.requestRender,
      this.lastCtrlCTime,
      (value) => { this.lastCtrlCTime = value; },
      (value) => { this.showExitNotice = value; },
    );
  }

  /**
   * Handle Escape:
   * - If prompt has text: clear it
   * - If prompt is empty: cancel generation (double-tap not needed)
   */
  /**
   * Record that a modal has been opened and push it onto the navigation stack.
   * Call this EVERY time a modal opens (except inside openModal()).
   *
   * @param name - The modal identifier (e.g. 'settings', 'help', 'process').
   */
  public modalOpened(name: string): void {
    modalOpened(this, name);
  }

  /**
   * Clear the modal navigation stack on non-modal user input (e.g. submit).
   */
  public clearModalStack(): void {
    clearModalStack(this.modalStack);
  }

  private handleEscape(): void {
    const result = handleEscape({
      helpOverlayActive: this.helpOverlayActive,
      shortcutsOverlayActive: this.shortcutsOverlayActive,
      bookmarkModal: this.bookmarkModal,
      agentDetailModal: this.agentDetailModal,
      liveTailModal: this.liveTailModal,
      settingsModal: this.settingsModal,
      sessionPickerModal: this.sessionPickerModal,
      profilePickerModal: this.profilePickerModal,
      contextInspectorModal: this.contextInspectorModal,
      processModal: this.processModal,
      modelPicker: this.modelPicker,
      filePicker: this.filePicker,
      blockActionsMenu: this.blockActionsMenu,
      selectionModal: this.selectionModal,
      commandMode: this.commandMode,
      modalStack: this.modalStack,
      modalReturnFocus: this.modalReturnFocus,
      panelFocused: this.panelFocused,
      indicatorFocused: this.indicatorFocused,
      prompt: this.prompt,
      cursorPos: this.cursorPos,
      requestRender: this.requestRender,
      saveUndoState: () => this.saveUndoState(),
      cancelGeneration: this.commandContext?.cancelGeneration,
      selectionCallback: this.selectionCallback,
      autocompleteReset: () => this.autocomplete?.reset(),
      autocompleteUpdate: (query: string) => this.autocomplete?.update(query),
      helpScrollOffset: this.helpScrollOffset,
      shortcutsScrollOffset: this.shortcutsScrollOffset,
    });
    this.prompt = result.prompt;
    this.cursorPos = result.cursorPos;
    this.commandMode = result.commandMode;
    this.helpOverlayActive = result.helpOverlayActive;
    this.helpScrollOffset = result.helpScrollOffset;
    this.shortcutsOverlayActive = result.shortcutsOverlayActive;
    this.shortcutsScrollOffset = result.shortcutsScrollOffset;
    this.selectionCallback = result.selectionCallback;
    this.panelFocused = result.panelFocused;
    this.indicatorFocused = result.indicatorFocused;
    this.modalReturnFocus = 'prompt';
  }

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
  private handlePaste(): void {
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
  private contentWidth = 76;

  /** Set the content width used for wrapping calculations. Call from main.ts. */
  public setContentWidth(w: number): void {
    this.contentWidth = w;
  }

  /**
   * Move cursor up or down by one WRAPPED line.
   * Uses the segment table to navigate visual lines, not raw \n lines.
   * Returns true if the cursor moved, false if at boundary.
   */
  private moveCursorVertical(direction: -1 | 1): boolean {
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
  private saveUndoState(): void {
    saveUndoState(this.undoStack, this.redoStack, this.prompt, this.cursorPos, InputHandler.MAX_UNDO);
  }

  /**
   * handleUndo - Ctrl+Z: pop from undo stack, push current to redo stack.
   */
  private handleUndo(): void {
    const state = undoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }

  /**
   * handleRedo - Ctrl+Shift+Z: pop from redo stack, push current to undo stack.
   */
  private handleRedo(): void {
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
  private findPathToken(): { start: number; prefix: string } | null {
    return findPathToken(this.prompt, this.cursorPos);
  }

  private handlePathCompletion(): boolean {
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
  private cyclePanelTab(direction: 'next' | 'prev'): void {
    const pm = this.uiServices.shell.panelManager;
    if (pm.isVisible()) {
      if (direction === 'next') pm.nextWorkspaceTab();
      else pm.prevWorkspaceTab();
      this.requestRender();
    }
  }

  private handlePanelIntegrationAction(activePanel: Panel | null, key: string): void {
    runPanelIntegrationAction(this.uiServices.shell.panelManager, activePanel, key, this.commandContext);
  }

  private wordWrapLine(line: string, maxW: number): string[] {
    return wordWrapLine(line, maxW);
  }
}
