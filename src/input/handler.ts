import { InputTokenizer } from '../core/tokenizer.ts';
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
import type { BlockMeta, ConversationManager } from '../core/conversation.ts';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { AgentDetailModal } from '../renderer/agent-detail-modal.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import { getKeybindingsManager } from './keybindings.ts';
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
  private commandRegistry: CommandRegistry | null = null;
  private commandContext: CommandContext | undefined = undefined;
  public autocomplete: AutocompleteEngine | null = null;
  public filePicker = new FilePickerModal();
  public modelPicker = new ModelPickerModal();
  public selectionModal = new SelectionModal();
  public searchManager = new SearchManager();
  public processModal = new ProcessModal();
  public liveTailModal = new LiveTailModal();
  public agentDetailModal = new AgentDetailModal();
  public contextInspectorModal = new ContextInspectorModal();
  public bookmarkModal = new BookmarkModal();
  public blockActionsMenu = new BlockActionsMenu();
  public settingsModal = new SettingsModal();

  /**
   * Modal navigation stack. Each element is the name of an open modal.
   * Used to support back-navigation via Escape.
   */
  public modalStack: string[] = [];
  public modalReturnFocus: 'prompt' | 'panel' | 'indicator' = 'prompt';
  public sessionPickerModal = new SessionPickerModal();
  public profilePickerModal = new ProfilePickerModal();
  /** True when the help overlay is visible. */
  public helpOverlayActive = false;
  public helpScrollOffset = 0;
  public shortcutsOverlayActive = false;
  public shortcutsScrollOffset = 0;
  private inputHistory: InputHistory | null = null;
  public historySearch: HistorySearch = new HistorySearch(() => this.inputHistory?.getEntries() ?? []);
  private conversationManager: ConversationManager | null = null;
  private selectionCallback: ((result: SelectionResult | null) => void) | null = null;
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
  ) {}

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
    callback: (result: SelectionResult | null) => void,
  ): void {
    this.modalOpened('selection');
    this.selectionModal.open(title, items, opts);
    this.selectionCallback = callback;
    this.requestRender();
  }

  public registerPaste(content: string): string {
    const result = registerPaste({
      pasteRegistry: this.pasteRegistry,
      nextPasteId: this.nextPasteId,
      imageRegistry: this.imageRegistry,
      nextImageId: this.nextImageId,
    }, content);
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
    return expandPrompt(this.pasteRegistry, this.imageRegistry, text);
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
    handleBookmark(this.conversationManager, this.getScrollTop, this.requestRender);
  }

  /**
   * handleBlockSave - Ctrl+S: Save nearest block content to a file.
   */
  private handleBlockSave(): void {
    handleBlockSave(this.conversationManager, this.getScrollTop, this.requestRender);
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
   */
  public feed(data: string): void {
    const tokens = this.tokenizer.feed(data);
    const history = this.getHistory();
    const vHeight = this.getViewportHeight();
    const scrollTop = this.getScrollTop();
    const lineCount = history.getLineCount();

    const kb = getKeybindingsManager();

    for (const token of tokens) {

      const modalRoute = handleModalTokenRoutes({
        history,
        searchShortcutMatch: token.type === 'key' && kb.matches('search', token),
        selectionModal: this.selectionModal,
        selectionCallback: this.selectionCallback,
        bookmarkModal: this.bookmarkModal,
        settingsModal: this.settingsModal,
        sessionPickerModal: this.sessionPickerModal,
        profilePickerModal: this.profilePickerModal,
        helpOverlayActive: this.helpOverlayActive,
        helpScrollOffset: this.helpScrollOffset,
        shortcutsOverlayActive: this.shortcutsOverlayActive,
        shortcutsScrollOffset: this.shortcutsScrollOffset,
        historySearch: this.historySearch,
        prompt: this.prompt,
        cursorPos: this.cursorPos,
        modelPicker: this.modelPicker,
        modalStack: this.modalStack,
        commandContext: this.commandContext,
        getViewportHeight: this.getViewportHeight,
        requestRender: this.requestRender,
        handleEscape: () => this.handleEscape(),
        liveTailModal: this.liveTailModal,
        processModal: this.processModal,
        agentDetailModal: this.agentDetailModal,
        contextInspectorModal: this.contextInspectorModal,
        modalOpened: (name) => this.modalOpened(name),
        filePicker: this.filePicker,
        imageRegistry: this.imageRegistry,
        nextImageId: this.nextImageId,
        saveUndoState: () => this.saveUndoState(),
        ensureInputCursorVisible: () => this.ensureInputCursorVisible(),
        formatFileSize,
        mediaTypeFromExt,
        imageExtensions: IMAGE_EXTENSIONS,
        blockActionsMenu: this.blockActionsMenu,
        executeBlockAction: (id) => this.executeBlockAction(id),
        searchManager: this.searchManager,
        scroll: this.scroll,
        getScrollTop: this.getScrollTop,
      }, token);
      this.selectionCallback = modalRoute.selectionCallback;
      this.helpOverlayActive = modalRoute.helpOverlayActive;
      this.helpScrollOffset = modalRoute.helpScrollOffset;
      this.shortcutsOverlayActive = modalRoute.shortcutsOverlayActive;
      this.shortcutsScrollOffset = modalRoute.shortcutsScrollOffset;
      this.prompt = modalRoute.prompt;
      this.cursorPos = modalRoute.cursorPos;
      this.nextImageId = modalRoute.nextImageId;
      if (modalRoute.handled) {
        continue;
      }

      // --- Tab: toggle keyboard focus between prompt and active panel ---
      const panelRoute = handlePanelFocusToken({
        panelFocused: this.panelFocused,
        commandMode: this.commandMode,
        searchActive: this.searchManager.active,
        autocompleteActive: !!this.autocomplete?.isActive,
        requestRender: this.requestRender,
        handlePathCompletion: () => this.handlePathCompletion(),
        cyclePanelTab: (direction) => this.cyclePanelTab(direction),
      }, token);
      this.panelFocused = panelRoute.panelFocused;
      if (panelRoute.handled) {
        continue;
      }

      const indicatorRoute = handleIndicatorFocusToken({
        indicatorFocused: this.indicatorFocused,
        modalOpened: (name) => this.modalOpened(name),
        processModal: this.processModal,
        requestRender: this.requestRender,
      }, token);
      this.indicatorFocused = indicatorRoute.indicatorFocused;
      if (indicatorRoute.handled) {
        continue;
      }

      const textRoute = handlePromptTextToken({
        prompt: this.prompt,
        cursorPos: this.cursorPos,
        commandMode: this.commandMode,
        nextPasteId: this.nextPasteId,
        nextImageId: this.nextImageId,
        pasteRegistry: this.pasteRegistry,
        imageRegistry: this.imageRegistry,
        inputHistory: this.inputHistory,
        commandRegistry: this.commandRegistry,
        commandContext: this.commandContext,
        autocomplete: this.autocomplete,
        filePicker: this.filePicker,
        modalOpened: (name) => this.modalOpened(name),
        saveUndoState: () => this.saveUndoState(),
        ensureInputCursorVisible: () => this.ensureInputCursorVisible(),
        registerPaste: (content) => this.registerPaste(content),
        requestRender: this.requestRender,
      }, token);
      if (textRoute.handled) {
        this.prompt = textRoute.prompt;
        this.cursorPos = textRoute.cursorPos;
        this.commandMode = textRoute.commandMode;
        continue;
      } else if (token.type === 'key') {
        const shortcutState = {
          prompt: this.prompt,
          cursorPos: this.cursorPos,
          commandMode: this.commandMode,
          autocomplete: this.autocomplete,
          historySearch: this.historySearch,
          searchManager: this.searchManager,
          conversationManager: this.conversationManager,
          commandContext: this.commandContext,
          contentWidth: this.contentWidth,
          getScrollTop: this.getScrollTop,
          getWrappedPromptInfo: (contentWidth: number) => this.getWrappedPromptInfo(contentWidth),
          saveUndoState: () => this.saveUndoState(),
          requestRender: this.requestRender,
          scroll: this.scroll,
          ensureInputCursorVisible: () => this.ensureInputCursorVisible(),
          handleCopy: () => this.handleCopy(),
          handleCtrlC: () => this.handleCtrlC(),
          handleBlockCopy: () => this.handleBlockCopy(),
          handleBookmark: () => this.handleBookmark(),
          handleBlockSave: () => this.handleBlockSave(),
          handleDiffApply: () => this.handleDiffApply(),
          handleUndo: () => this.handleUndo(),
          handleRedo: () => this.handleRedo(),
          handlePaste: () => this.handlePaste(),
          handleEscape: () => this.handleEscape(),
          cyclePanelTab: (direction: 'next' | 'prev') => this.cyclePanelTab(direction),
        };
        if (handleGlobalShortcutToken(shortcutState, token, vHeight)) {
          this.prompt = shortcutState.prompt;
          this.cursorPos = shortcutState.cursorPos;
          this.commandMode = shortcutState.commandMode;
          continue;
        }

        // --- Command mode routing ---
        const commandState = {
          commandMode: this.commandMode,
          prompt: this.prompt,
          cursorPos: this.cursorPos,
          autocomplete: this.autocomplete,
          modalStack: this.modalStack,
          commandRegistry: this.commandRegistry,
          commandContext: this.commandContext,
          conversationManager: this.conversationManager,
          requestRender: this.requestRender,
          handleEscape: () => this.handleEscape(),
        };
        if (handleCommandModeToken(commandState, token)) {
          this.commandMode = commandState.commandMode;
          this.prompt = commandState.prompt;
          this.cursorPos = commandState.cursorPos;
          continue;
        }

        const keyRoute = handlePromptKeyToken({
          prompt: this.prompt,
          cursorPos: this.cursorPos,
          commandMode: this.commandMode,
          contentWidth: this.contentWidth,
          inputHistory: this.inputHistory,
          indicatorFocused: this.indicatorFocused,
          conversationManager: this.conversationManager,
          commandContext: this.commandContext,
          autocomplete: this.autocomplete,
          blockActionsMenu: { open: (block: BlockMeta) => this.blockActionsMenu.open(block) },
          processModal: this.processModal,
          modalOpened: (name) => this.modalOpened(name),
          saveUndoState: () => this.saveUndoState(),
          ensureInputCursorVisible: (width) => this.ensureInputCursorVisible(width),
          getWrappedPromptInfo: (width) => this.getWrappedPromptInfo(width),
          moveCursorVertical: (direction) => this.moveCursorVertical(direction),
          handlePathCompletion: () => this.handlePathCompletion(),
          handleBlockToggle: () => this.handleBlockToggle(),
          findMarkerAtPos: (pos) => this.findMarkerAtPos(pos),
          cleanupMarkerRegistry: (text) => this.cleanupMarkerRegistry(text),
          expandPrompt: (text) => this.expandPrompt(text),
          scroll: this.scroll,
          exitApp: this.exitApp,
          requestRender: this.requestRender,
        }, token);
        if (keyRoute.handled) {
          this.prompt = keyRoute.prompt;
          this.cursorPos = keyRoute.cursorPos;
          this.commandMode = keyRoute.commandMode;
          this.indicatorFocused = keyRoute.indicatorFocused;
          continue;
        }
      } else if (token.type === 'mouse') {
        const mouseRoute = handleMouseToken({
          conversationManager: this.conversationManager,
          selection: this.selection,
          mouseDownRow: this.mouseDownRow,
          mouseDownCol: this.mouseDownCol,
          scrollTop,
          viewportHeight: vHeight,
          lineCount,
          scroll: this.scroll,
          requestRender: this.requestRender,
          handlePaste: () => this.handlePaste(),
          handleCopy: () => this.handleCopy(),
        }, token);
        this.mouseDownRow = mouseRoute.mouseDownRow;
        this.mouseDownCol = mouseRoute.mouseDownCol;
        if (mouseRoute.handled) {
          continue;
        }
      }
    }
    this.requestRender();
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
    });
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
    const pm = getPanelManager();
    if (pm.isVisible()) {
      if (direction === 'next') pm.nextPanel();
      else pm.prevPanel();
      this.requestRender();
    }
  }

  private wordWrapLine(line: string, maxW: number): string[] {
    return wordWrapLine(line, maxW);
  }
}
