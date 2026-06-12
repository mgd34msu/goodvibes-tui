import { InfiniteBuffer } from './history.ts';
import { createEmptyLine, type Line, type Cell } from '../types/grid.ts';
import type { SplashOptions } from '../utils/splash-lines.ts';
import type { ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types';
import type { ProviderMessage, ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { TranscriptEventKind } from '@pellux/goodvibes-sdk/platform/core';
import type { SystemMessageKind } from './system-message-router.ts';
import {
  ConversationManager as SdkConversationManager,
  type BlockMeta as SdkBlockMeta,
} from '@pellux/goodvibes-sdk/platform/core';
import {
  addConversationSplashScreen,
  appendConversationMessages,
  conversationTextToLines,
  logConversationText,
  renderConversationAssistantMessage,
  renderConversationSystemMessage,
  renderConversationToolMessage,
  renderConversationUserMessage,
} from './conversation-rendering.ts';
import { renderMarkdown } from '../renderer/markdown.ts';

/**
 * ConversationManager - TUI subclass of the SDK's ConversationManager.
 * Adds InfiniteBuffer history, block registry, collapse state, width tracking,
 * dirty flag, display methods, splash screen, error/event navigation, and
 * Line[]-based rendering atop the SDK's message management.
 */

// Re-export SDK types for backward compatibility
export type {
  TokenUsage,
  ConversationMessageSnapshot,
  ConversationTitleSource,
} from '@pellux/goodvibes-sdk/platform/core';

export type { SdkBlockMeta };

/** TUI extends the SDK BlockMeta with rendering position fields. */
export interface BlockMeta extends SdkBlockMeta {
  /** Index of this block (increments per renderable block). */
  blockIndex: number;
  /** First rendered line index in the history buffer. */
  startLine: number;
  /** Number of rendered lines (when not collapsed). */
  lineCount: number;
  /** Stable key for collapse state persistence across rebuilds (e.g. msg_N). */
  collapseKey: string;
}

// Import internal types needed for rendering helpers
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
type Message = ConversationMessageSnapshot;

export class ConversationManager extends SdkConversationManager {
  public history = new InfiniteBuffer();
  private _getWidth: () => number;
  /** Tracks the rendered width; a change invalidates the full history. */
  private lastRenderedWidth = 0;
  /** When true the buffer needs to be rebuilt before the next display. */
  private dirty = true;
  /** Index of the first message not yet appended to the buffer. */
  private appendedUpTo = 0;
  /** Optional config manager for display settings. */
  private _configManager: ConfigManager | null = null;
  /** Collapse state: stable key (msg_N) -> collapsed (true = collapsed). */
  private collapseState: Map<string, boolean> = new Map();
  /** Block registry: track rendered blocks for copy/apply. */
  protected blockRegistry: BlockMeta[] = [];
  /** Message index -> first rendered line index in the history buffer. */
  private messageLineRegistry: number[] = [];
  /**
   * Registry of rendered line indices for system messages whose kind is
   * navigable (error-navigation worthy).
   *
   * Kind → navigable mapping:
   *   - 'system'      YES — generic/catch-all messages (failures, provider errors,
   *                         session events); the default for any un-prefixed message
   *   - 'wrfc'        YES — WRFC chain events (failures matter for navigation)
   *   - 'operational' NO  — noisy tool/scan/plugin/MCP status; not worth jumping to
   *
   * This replaces the old /error/i substring test, which missed failure phrases
   * like "request failed" / "rate limited" and false-positived on benign info
   * text that happened to contain the word "error".
   */
  private errorLineRegistry: number[] = [];
  /** Maps message index → SystemMessageKind for system-role messages. */
  private messageKindRegistry: Map<number, SystemMessageKind> = new Map();
  /** Streaming block start line in history buffer (for incremental streaming update). */
  private streamingStartLine = -1;
  /**
   * Message index at the time of the last clearDisplay() call.
   * rebuildHistory() renders only messages at or after this index, so the
   * display stays blank for messages added before the clear while LLM history
   * is fully preserved. Reset to 0 on resetAll() or rebuildHistory() width change.
   */
  private _displayFromMessageIndex = 0;

  public suppressSplash: boolean = false;
  public splashOptions: SplashOptions = {};

  constructor(
    getWidth: () => number = () => process.stdout.columns || 80,
    configManager?: ConfigManager,
  ) {
    super();
    this._getWidth = getWidth;
    this._configManager = configManager ?? null;
  }

  /** Wire in a config manager after construction (e.g. from main.ts). */
  public setConfigManager(cm: ConfigManager): void {
    this._configManager = cm;
  }

  /** Update the width provider so shell layout can own transcript width. */
  public setWidthProvider(getWidth: () => number): void {
    this._getWidth = getWidth;
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Overrides: add markDirty() to message mutations
  // -------------------------------------------------------------------------

  public override addUserMessage(content: string | ContentPart[]): void {
    super.addUserMessage(content);
    this.markDirty();
  }

  public override addAssistantMessage(
    content: string,
    opts?: {
      toolCalls?: ToolCall[];
      reasoningContent?: string;
      reasoningSummary?: string;
      usage?: import('@pellux/goodvibes-sdk/platform/core').TokenUsage;
      model?: string;
      provider?: string;
    },
  ): void {
    super.addAssistantMessage(content, opts);
    this.markDirty();
  }

  public override addToolResults(results: ToolResult[]): void {
    super.addToolResults(results);
    this.markDirty();
  }

  public override addSystemMessage(content: string): void {
    // Clear any stale kind entry at the index this message will occupy.
    // undo() splices the tail of this.messages, freeing indices that ARE reused
    // by subsequent adds. Without this delete, a recycled index could carry a
    // stale kind (e.g. 'operational') and silently mis-classify the new message.
    const nextIndex = this.getMessageSnapshot().length;
    this.messageKindRegistry.delete(nextIndex);
    super.addSystemMessage(content);
    this.markDirty();
  }

  /**
   * addTypedSystemMessage - Add a system message with an explicit kind tag.
   * The kind is stored in messageKindRegistry (keyed by the message index that
   * will be assigned after the push) so that renderConversationSystemMessage
   * can use it instead of text-based pattern matching.
   *
   * Called by SystemMessageRouter.routeTypedSystemMessage when routing to the
   * conversation surface. Falls back to addSystemMessage for callers that do
   * not have kind information.
   */
  public addTypedSystemMessage(content: string, kind: SystemMessageKind): void {
    // getMessageSnapshot().length is the index this message will receive after
    // addSystemMessage appends it to the messages array.
    const nextIndex = this.getMessageSnapshot().length;
    this.messageKindRegistry.set(nextIndex, kind);
    super.addSystemMessage(content);
    this.markDirty();
  }

  public override undo(): boolean {
    const result = super.undo();
    if (result) {
      // undo() splices the messages tail at the last user-message index, meaning
      // freed indices CAN be reused by subsequent adds. Purge all registry entries
      // at or after the new message count so a recycled index cannot carry a stale
      // kind from the evicted turn (e.g. 'operational' mis-classifying a bare add
      // as non-navigable, or 'wrfc' wrongly making an operational message navigable).
      const postUndoCount = this.getMessageSnapshot().length;
      for (const key of this.messageKindRegistry.keys()) {
        if (key >= postUndoCount) this.messageKindRegistry.delete(key);
      }
      this.markDirty();
    }
    return result;
  }

  public override redo(): boolean {
    const result = super.redo();
    if (result) this.markDirty();
    return result;
  }

  public override removeMessagesAfter(count: number): void {
    super.removeMessagesAfter(count);
    this.markDirty();
  }

  public override markLastUserMessageCancelled(): void {
    super.markLastUserMessageCancelled();
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Streaming overrides: add rendering tracking
  // -------------------------------------------------------------------------

  /**
   * startStreamingBlock - Add a placeholder assistant message for incremental display.
   * Called when streaming begins.
   */
  public override startStreamingBlock(): void {
    super.startStreamingBlock();
    this.markDirty();
    // Record the line where the streaming block starts so updates can be incremental
    this.flushHistory();
    this.streamingStartLine = this.history.getLineCount();
  }

  /**
   * updateStreamingBlock - Update the in-progress streaming block with accumulated content.
   * Called per-delta during streaming. Does NOT trigger a full rebuild — instead it
   * directly updates the history buffer from streamingStartLine onward.
   */
  public override updateStreamingBlock(content: string): void {
    super.updateStreamingBlock(content);
    // Incrementally update the history buffer instead of full rebuild
    if (this.streamingStartLine >= 0) {
      const width = this._getWidth();
      this.history.truncateToLine(this.streamingStartLine);
      const rendered = renderMarkdown(content, width);
      this.history.addLines(rendered);
    }
  }

  /**
   * finalizeStreamingBlock - Remove the streaming placeholder.
   * The orchestrator calls addAssistantMessage immediately after with the final content.
   */
  public override finalizeStreamingBlock(): void {
    super.finalizeStreamingBlock();
    this.streamingStartLine = -1;
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Overrides: reset / replace / branch operations that also affect display
  // -------------------------------------------------------------------------

  /**
   * resetAll - Clear both the display buffer and all conversation messages.
   * This is a full reset; the LLM context is wiped.
   */
  public override resetAll(): void {
    super.resetAll();
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
    this.collapseState.clear();
    this.blockRegistry = [];
    this.messageLineRegistry = [];
    this.errorLineRegistry = [];
    this.messageKindRegistry = new Map();
    this.streamingStartLine = -1;
    this._displayFromMessageIndex = 0; // full reset — show everything on next render
  }

  /**
   * replaceMessagesForLLM - Replace the conversation's LLM-visible messages with a new set.
   * Used by small-window compaction to swap in truncated messages without an LLM call.
   * System messages are always preserved at the front.
   *
   * @param newMessages - Replacement ProviderMessage array (user/assistant/tool roles only)
   */
  public override replaceMessagesForLLM(newMessages: ProviderMessage[]): void {
    super.replaceMessagesForLLM(newMessages);
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }

  /**
   * switchBranch - Replace the active messages with the stored branch snapshot.
   * Returns true on success, false if the branch does not exist.
   */
  public override switchBranch(name: string): boolean {
    const result = super.switchBranch(name);
    if (result) this.markDirty();
    return result;
  }

  /**
   * mergeBranch - Append all messages from the named branch that come after
   * the fork point.
   * Returns true on success, false if the branch does not exist.
   */
  public override mergeBranch(name: string): boolean {
    const result = super.mergeBranch(name);
    if (result) this.markDirty();
    return result;
  }

  /**
   * fromJSON - Restore conversation from persisted data.
   */
  public override fromJSON(data: {
    messages: Message[];
    branches?: Record<string, Message[]>;
    currentBranch?: string;
    title?: string;
    titleSource?: import('@pellux/goodvibes-sdk/platform/core').ConversationTitleSource;
  }): void {
    super.fromJSON(data);
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // TUI-only display methods
  // -------------------------------------------------------------------------

  public getDisplayBlocks(): Line[] {
    this.flushHistory();
    return this.history.getAllLines();
  }

  /**
   * rebuildHistory - Full rebuild. Called when width changes or on first render.
   * For incremental appends use flushHistory().
   */
  public rebuildHistory(): void {
    this.history.clear();
    this.appendedUpTo = 0;
    this.blockRegistry = [];
    this.messageLineRegistry = [];
    this.errorLineRegistry = [];
    // messageKindRegistry is NOT cleared here: kind info is set at add-time
    // and must survive width-change rebuilds.
    const width = this._getWidth();
    this.lastRenderedWidth = width;
    this.dirty = false;

    const snapshot = this.getMessageSnapshot();
    // When _displayFromMessageIndex > 0, clearDisplay() was called. Only render
    // messages added after the clear — the pre-clear history stays off-screen.
    // On a full rebuild (e.g. width change), reset the display-start to 0 so the
    // user can scroll back to the full history if needed.
    const displayStart = this._displayFromMessageIndex;
    const visibleSnapshot = displayStart > 0 ? snapshot.slice(displayStart) : snapshot;

    // Tool messages ARE rendered (as collapsed blocks); this filter is only
    // for determining whether to show the splash screen (tool-only messages
    // don't count as visible conversation content for splash purposes).
    const displayMessages = visibleSnapshot.filter(
      (m) => m.role !== 'tool' && m.role !== 'system',
    );

    if (displayMessages.length === 0 && displayStart === 0 && !this.suppressSplash) {
      this.addSplashScreen(width);
      return;
    }

    this.appendMessages(visibleSnapshot, width, displayStart);
    this.appendedUpTo = snapshot.length;
  }

  /**
   * flushHistory - Incremental update. Appends only newly added messages.
   * Falls back to a full rebuild when the terminal width has changed.
   */
  public flushHistory(): void {
    const currentWidth = this._getWidth();
    if (!this.dirty && currentWidth === this.lastRenderedWidth) return;
    this.rebuildHistory();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private renderingContext() {
    return {
      history: this.history,
      blockRegistry: this.blockRegistry,
      collapseState: this.collapseState,
      errorLineRegistry: this.errorLineRegistry,
      messageKindRegistry: this.messageKindRegistry as ReadonlyMap<number, SystemMessageKind>,
      configManager: this._configManager,
      splashOptions: this.splashOptions,
    };
  }

  private renderUserMessage(message: Extract<Message, { role: 'user' }>, width: number): void {
    renderConversationUserMessage(this.renderingContext(), message, width);
  }

  private renderAssistantMessage(
    message: Extract<Message, { role: 'assistant' }>,
    width: number,
    lineNumberMode: 'all' | 'code' | 'off',
    collapseThreshold: number,
    msgIdx: number,
  ): void {
    renderConversationAssistantMessage(this.renderingContext(), message, width, lineNumberMode, collapseThreshold, msgIdx);
  }

  private renderSystemMessage(message: Extract<Message, { role: 'system' }>, width: number, msgIdx: number): void {
    renderConversationSystemMessage(this.renderingContext(), message, width, msgIdx);
  }

  private renderToolMessage(message: Extract<Message, { role: 'tool' }>, width: number, msgIdx: number): void {
    renderConversationToolMessage(this.renderingContext(), message, width, msgIdx);
  }

  /**
   * Render a slice of messages into the history buffer.
   *
   * @param msgIndexOffset - Absolute index of messages[0] in the full snapshot.
   *   Must equal displayStart when rendering a post-clearDisplay slice so that
   *   the renderer can resolve messageKindRegistry keys (which are absolute)
   *   from its slice-relative loop counter.
   */
  private appendMessages(messages: Message[], width: number, msgIndexOffset = 0): void {
    appendConversationMessages(this.renderingContext(), messages, width, this.messageLineRegistry, msgIndexOffset);
  }

  /** Find the nearest block to a given line index, optionally filtered by type. */
  public findNearestBlock(lineIndex: number, typeFilter?: string): BlockMeta | null {
    let nearest: BlockMeta | null = null;
    let nearestDist = Infinity;
    for (const block of this.blockRegistry) {
      if (typeFilter !== undefined && block.type !== typeFilter) continue;
      if (lineIndex >= block.startLine && lineIndex < block.startLine + block.lineCount) {
        return block;
      }
      const dist = Math.abs(block.startLine - lineIndex);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = block;
      }
    }
    return nearest;
  }

  /**
   * isCollapsed - Returns whether the block at blockIndex is collapsed.
   */
  public isCollapsed(blockIndex: number): boolean {
    const block = this.blockRegistry[blockIndex];
    if (!block) return false;
    return this.collapseState.get(block.collapseKey) ?? false;
  }

  /**
   * getBlockContentAtLine - Find the nearest block to the given line index.
   * Returns the raw content of the block, or null if not found.
   */
  public getBlockContentAtLine(lineIndex: number): string | null {
    return this.findNearestBlock(lineIndex)?.rawContent ?? null;
  }

  /**
   * getDiffAtLine - Find the diff block nearest the given line index.
   * Returns file path and original/updated content for applying.
   */
  public getDiffAtLine(lineIndex: number): { filePath: string; original: string; updated: string } | null {
    const nearest = this.findNearestBlock(lineIndex, 'diff');
    if (!nearest || !nearest.filePath) return null;
    return {
      filePath: nearest.filePath,
      original: nearest.diffOriginal ?? '',
      updated: nearest.diffUpdated ?? '',
    };
  }

  /**
   * toggleCollapseAtLine - Toggle the collapse state of the nearest block to the given line.
   * Triggers a rebuild. Returns the blockIndex toggled, or -1 if none found.
   */
  public toggleCollapseAtLine(lineIndex: number): number {
    const nearest = this.findNearestBlock(lineIndex);
    if (!nearest) return -1;
    const current = this.collapseState.get(nearest.collapseKey) ?? false;
    this.collapseState.set(nearest.collapseKey, !current);
    this.markDirty();
    return nearest.blockIndex;
  }

  /** Returns a read-only view of the block registry for external consumers. */
  public getBlockRegistry(): readonly BlockMeta[] {
    return this.blockRegistry;
  }

  /**
   * getErrorLines - Returns line indices in the rendered history buffer for
   * system messages whose kind is navigable (see NAVIGABLE_KINDS in
   * conversation-rendering.ts: 'system' and 'wrfc'). Operational messages
   * are excluded regardless of message text. Triggers a history flush if dirty.
   */
  public getErrorLines(): number[] {
    this.flushHistory();
    return [...this.errorLineRegistry];
  }

  /**
   * nextErrorLine - Find the next error line after currentLine (wraps around).
   * Returns -1 if there are no error lines.
   */
  public nextErrorLine(currentLine: number): number {
    const errors = this.getErrorLines();
    if (errors.length === 0) return -1;
    const after = errors.find(l => l > currentLine);
    return after ?? errors[0];
  }

  /**
   * prevErrorLine - Find the previous error line before currentLine (wraps around).
   * Returns -1 if there are no error lines.
   */
  public prevErrorLine(currentLine: number): number {
    const errors = this.getErrorLines();
    if (errors.length === 0) return -1;
    const before = [...errors].reverse().find(l => l < currentLine);
    return before ?? errors[errors.length - 1];
  }

  public nextTranscriptEventLine(currentLine: number, kind: TranscriptEventKind | 'all' = 'all'): number {
    this.flushHistory();
    const index = this.getTranscriptEventIndex();
    const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
    if (events.length === 0) return -1;
    const lines = events
      .map((event) => this.messageLineRegistry[event.messageIndex] ?? -1)
      .filter((line) => line >= 0)
      .sort((a, b) => a - b);
    if (lines.length === 0) return -1;
    const after = lines.find((line) => line > currentLine);
    return after ?? lines[0]!;
  }

  public prevTranscriptEventLine(currentLine: number, kind: TranscriptEventKind | 'all' = 'all'): number {
    this.flushHistory();
    const index = this.getTranscriptEventIndex();
    const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
    if (events.length === 0) return -1;
    const lines = events
      .map((event) => this.messageLineRegistry[event.messageIndex] ?? -1)
      .filter((line) => line >= 0)
      .sort((a, b) => a - b);
    if (lines.length === 0) return -1;
    const before = [...lines].reverse().find((line) => line < currentLine);
    return before ?? lines[lines.length - 1]!;
  }

  public setSplashSuppressed(suppressed: boolean): void {
    if (this.suppressSplash === suppressed) return;
    this.suppressSplash = suppressed;
    this.markDirty();
  }

  private addSplashScreen(width: number): void {
    addConversationSplashScreen(this.renderingContext(), width);
  }

  public textToLines(text: string, width: number, style: Partial<Cell> = {}): Line[] {
    return conversationTextToLines(text, width, style);
  }

  public log(text: string, style: Partial<Cell> = {}, indent = '      '): void {
    logConversationText(this.renderingContext(), this._getWidth(), text, style, indent);
  }

  /**
   * clearDisplay - Clear the visual history buffer without touching the LLM context messages.
   * The next render will show a blank conversation area. Subsequent message additions
   * rebuild the display incrementally from that point forward.
   *
   * Contract:
   * - getDisplayBlocks() returns an empty array immediately after this call.
   * - getMessageSnapshot() is unaffected — full LLM history is preserved.
   * - resetAll() (which clears both display and messages) continues to work.
   * - rebuildHistory() can be called by callers that need a full display rebuild.
   */
  public clearDisplay(): void {
    this.history.clear();
    this.blockRegistry = [];
    this.messageLineRegistry = [];
    this.errorLineRegistry = [];
    // messageKindRegistry is NOT cleared here. The underlying messages array is
    // preserved by clearDisplay(); kind entries for pre-clear messages are harmless
    // because those messages are hidden by _displayFromMessageIndex and never rendered.
    // Clearing the registry would cause kind loss for pre-clear messages that become
    // visible again after a subsequent width-change rebuild (which resets displayStart
    // to 0), incorrectly making operational messages navigable.
    // Advance _displayFromMessageIndex to exclude all current messages from display.
    // rebuildHistory() will only render messages added AFTER this point.
    this._displayFromMessageIndex = this.getMessageSnapshot().length;
    this.appendedUpTo = this._displayFromMessageIndex;
    this.dirty = false;
    // Do NOT re-render here — display stays blank until the next message is added.
    // The lastRenderedWidth is kept so subsequent appends use the correct width.
  }
}

export { parseDiffForApply, applyDiffContent } from '@pellux/goodvibes-sdk/platform/core';
