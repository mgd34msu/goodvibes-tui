import { InfiniteBuffer } from '@pellux/goodvibes-sdk/platform/core/history';
import { createEmptyLine, type Line, type Cell } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { SplashOptions } from '@pellux/goodvibes-sdk/platform/utils/splash-lines';
import type { ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ProviderMessage, ContentPart } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core/session-memory';
import { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core/session-lineage';
import { buildTranscriptEventIndex } from '@pellux/goodvibes-sdk/platform/core/transcript-events/index';
import type { TranscriptEventKind } from '@pellux/goodvibes-sdk/platform/core/transcript-events/index';
import { compactConversation } from './conversation-compaction';
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
import {
  cloneBranchMap,
  cloneMessages,
  deriveConversationTitle,
  messagesToInternal,
  restoreBranchMap,
} from './conversation-utils';
import { applyDiffContent, parseDiffForApply } from './conversation-diff';

/**
 * ConversationManager - Owns conversation messages and the rendered history buffer.
 * Supports tool-use messages (assistant with tool calls, tool results).
 *
 * History is rebuilt lazily: a dirty flag is set on every message mutation and
 * the buffer is only actually reconstructed when getDisplayBlocks() is called
 * or when the width changes. This avoids O(n) rebuilds per turn in long sessions.
 */
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

type AssistantMessage = { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoningContent?: string; reasoningSummary?: string; usage?: TokenUsage; model?: string; provider?: string };

export type ConversationMessageSnapshot =
  | { role: 'user'; content: string | ContentPart[]; cancelled?: boolean }
  | AssistantMessage
  | { role: 'system'; content: string }
  | { role: 'tool'; callId: string; content: string; toolName?: string };

type Message = ConversationMessageSnapshot;
export type ConversationTitleSource = 'system' | 'user';

/** Metadata for a rendered block (code, tool, or diff). */
export interface BlockMeta {
  /** Index of this block (increments per renderable block). */
  blockIndex: number;
  /** Type of block content. */
  type: 'tool' | 'code' | 'diff' | 'thinking';
  /** First rendered line index in the history buffer. */
  startLine: number;
  /** Number of rendered lines (when not collapsed). */
  lineCount: number;
  /** Raw text content (code source, tool output, diff text). */
  rawContent: string;
  /** Stable key for collapse state persistence across rebuilds (e.g. msg_N). */
  collapseKey: string;
  /** File path for diff blocks. */
  filePath?: string;
  /** Parsed diff for apply: original/updated sections. */
  diffOriginal?: string;
  diffUpdated?: string;
}

export class ConversationManager {
  public history = new InfiniteBuffer();
  /** Auto-generated or manually set conversation title. */
  private _title = '';
  private _titleSource: ConversationTitleSource = 'system';
  private messages: Message[] = [];
  private getWidth: () => number;
  /** Tracks the rendered width; a change invalidates the full history. */
  private lastRenderedWidth = 0;
  /** When true the buffer needs to be rebuilt before the next display. */
  private dirty = true;
  /** Index of the first message not yet appended to the buffer. */
  private appendedUpTo = 0;
  /** Optional config manager for display settings. */
  private configManager: ConfigManager | null = null;
  /** Session memory store wired by the runtime composition root. */
  private sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null = null;
  /** Session lineage tracker wired by the runtime composition root. */
  private sessionLineageTracker: SessionLineageTracker = new SessionLineageTracker();
  /** Collapse state: stable key (msg_N) -> collapsed (true = collapsed). */
  private collapseState: Map<string, boolean> = new Map();
  /** Block registry: track rendered blocks for copy/apply. */
  protected blockRegistry: BlockMeta[] = [];
  /** Message index -> first rendered line index in the history buffer. */
  private messageLineRegistry: number[] = [];
  /** Registry of rendered line indices for system messages matching /error/i. */
  private errorLineRegistry: number[] = [];
  /** Streaming block start line in history buffer (for incremental streaming update). */
  private streamingStartLine = -1;
  /** Undo stack: each entry is a turn (user msg + all subsequent non-user msgs until next user). */
  private undoStack: Message[][] = [];
  /** Branch storage: named snapshots of messages[]. */
  private branches: Map<string, Message[]> = new Map();
  /** Name of the currently active branch. */
  private currentBranch: string = 'main';

  constructor(
    getWidth: () => number = () => process.stdout.columns || 80,
    configManager?: ConfigManager,
  ) {
    this.getWidth = getWidth;
    this.configManager = configManager ?? null;
  }

  /** Wire in a config manager after construction (e.g. from main.ts). */
  public setConfigManager(cm: ConfigManager): void {
    this.configManager = cm;
  }

  /** Wire in the session memory store used for compaction summaries. */
  public setSessionMemoryStore(store: Pick<SessionMemoryStore, 'list'>): void {
    this.sessionMemoryStore = store;
  }

  /** Wire in the session lineage tracker used for compaction output. */
  public setSessionLineageTracker(tracker: SessionLineageTracker): void {
    this.sessionLineageTracker = tracker;
  }

  /** Read the session memory store used for compaction summaries. */
  public getSessionMemoryStore(): Pick<SessionMemoryStore, 'list'> | null {
    return this.sessionMemoryStore;
  }

  /** Read the session lineage tracker used for compaction output. */
  public getSessionLineageTracker(): SessionLineageTracker {
    return this.sessionLineageTracker;
  }

  /** Update the width provider so shell layout can own transcript width. */
  public setWidthProvider(getWidth: () => number): void {
    this.getWidth = getWidth;
    this.markDirty();
  }

  /** Returns messages formatted for LLM provider consumption. */
  public getMessagesForLLM(): ProviderMessage[] {
    const result: ProviderMessage[] = [];
    for (const m of this.messages) {
      if (m.role === 'system') continue; // System messages go via systemPrompt param
      if (m.role === 'user') {
        result.push({ role: 'user', content: m.content as string | ContentPart[] });
      } else if (m.role === 'assistant') {
        result.push({ role: 'assistant', content: m.content, toolCalls: m.toolCalls });
      } else if (m.role === 'tool') {
        result.push({ role: 'tool', callId: m.callId, content: m.content, ...(m.toolName ? { name: m.toolName } : {}) });
      }
    }
    return result;
  }

  private findToolName(callId: string): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
      const match = message.toolCalls.find((call) => call.id === callId);
      if (match?.name) return match.name;
    }
    return undefined;
  }

  public addUserMessage(content: string | ContentPart[]): void {
    // Auto-generate title from first user message if not already set
    if (this._title === '' && typeof content === 'string' && content.trim().length > 0) {
      this.setSystemTitle(deriveConversationTitle(content));
    }
    this.messages.push({ role: 'user', content });
    // Clear undo stack when new user input is added (can't redo past new input)
    this.undoStack = [];
    this.markDirty();
  }

  /** Add an assistant message, optionally with tool calls (when the LLM invoked tools). */
  public addAssistantMessage(content: string, opts?: { toolCalls?: ToolCall[]; reasoningContent?: string; reasoningSummary?: string; usage?: TokenUsage; model?: string; provider?: string }): void {
    this.messages.push({ role: 'assistant', content, toolCalls: opts?.toolCalls, reasoningContent: opts?.reasoningContent, reasoningSummary: opts?.reasoningSummary, usage: opts?.usage, model: opts?.model, provider: opts?.provider });
    this.markDirty();
  }

  /** Add a batch of tool results after tool calls have been executed. */
  public addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      const content = r.success
        ? (r.output ?? 'Tool completed successfully.')
        : `Error: ${r.error ?? 'Unknown error'}`;
      const toolName = this.findToolName(r.callId);
      this.messages.push({
        role: 'tool',
        callId: r.callId,
        content,
        ...(toolName ? { toolName } : {}),
      });
    }
    this.markDirty();
  }

  /**
   * undo - Remove the last complete turn (the last user message and all subsequent
   * non-user messages). Pushes the removed messages onto the undo stack.
   * Returns true if a turn was removed, false if there was nothing to undo.
   */
  public undo(): boolean {
    // Find the index of the last user message
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return false;

    // Collect the turn: user message + everything that follows (assistant, tool)
    const turn = this.messages.splice(lastUserIdx);
    this.undoStack.push(turn);
    this.markDirty();
    return true;
  }

  /**
   * redo - Restore the most recently undone turn.
   * Returns true if a turn was restored, false if the undo stack is empty.
   */
  public redo(): boolean {
    if (this.undoStack.length === 0) return false;
    const turn = this.undoStack.pop()!;
    this.messages.push(...turn);
    this.markDirty();
    return true;
  }

  /**
   * getLastUserMessage - Returns the content of the last user message, or null
   * if there are no user messages or the content is not a plain string.
   */
  public getLastUserMessage(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        const content = this.messages[i].content;
        return typeof content === 'string' ? content : null;
      }
    }
    return null;
  }

  /** Returns the current number of messages (for rollback tracking). */
  public getMessageCount(): number {
    return this.messages.length;
  }

  /** Remove all messages after the given index (for cancellation rollback). */
  public removeMessagesAfter(count: number): void {
    if (count < this.messages.length) {
      this.messages.length = count;
      this.markDirty();
    }
  }

  /** Mark the last user message as cancelled (red + strikethrough in display). */
  public markLastUserMessageCancelled(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        (this.messages[i] as { cancelled?: boolean }).cancelled = true;
        this.markDirty();
        return;
      }
    }
  }

  public addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
    this.markDirty();
  }

  /**
   * startStreamingBlock - Add a placeholder assistant message for incremental display.
   * Called when streaming begins.
   */
  public startStreamingBlock(): void {
    this.messages.push({ role: 'assistant', content: '' });
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
  public updateStreamingBlock(content: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        (this.messages[i] as { role: 'assistant'; content: string }).content = content;
        // Incrementally update the history buffer instead of full rebuild
        if (this.streamingStartLine >= 0) {
          const width = this.getWidth();
          this.history.truncateToLine(this.streamingStartLine);
          const rendered = renderMarkdown(content, width);
          this.history.addLines(rendered);
        }
        return;
      }
    }
  }

  /**
   * finalizeStreamingBlock - Remove the streaming placeholder.
   * The orchestrator calls addAssistantMessage immediately after with the final content.
   */
  public finalizeStreamingBlock(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        this.messages.splice(i, 1);
        break;
      }
    }
    this.streamingStartLine = -1;
    this.markDirty();
  }

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
    const width = this.getWidth();
    this.lastRenderedWidth = width;
    this.dirty = false;

    // Tool messages ARE rendered (as collapsed blocks); this filter is only
    // for determining whether to show the splash screen (tool-only messages
    // don't count as visible conversation content for splash purposes).
    const displayMessages = this.messages.filter(
      (m) => m.role !== 'tool' && m.role !== 'system',
    );

    if (displayMessages.length === 0 && !this.suppressSplash) {
      this.addSplashScreen(width);
      return;
    }

    this.appendMessages(this.messages, width);
    this.appendedUpTo = this.messages.length;
  }

  /**
   * flushHistory - Incremental update. Appends only newly added messages.
   * Falls back to a full rebuild when the terminal width has changed.
   */
  public flushHistory(): void {
    const currentWidth = this.getWidth();
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
      configManager: this.configManager,
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

  private renderSystemMessage(message: Extract<Message, { role: 'system' }>, width: number): void {
    renderConversationSystemMessage(this.renderingContext(), message, width);
  }

  private renderToolMessage(message: Extract<Message, { role: 'tool' }>, width: number, msgIdx: number): void {
    renderConversationToolMessage(this.renderingContext(), message, width, msgIdx);
  }

  /** Render a slice of messages into the history buffer. */
  private appendMessages(messages: Message[], width: number): void {
    appendConversationMessages(this.renderingContext(), messages, width, this.messageLineRegistry);
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
   * system messages that contain 'error' (case-insensitive).
   * Triggers a history flush if dirty.
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

  public suppressSplash: boolean = false;
  public splashOptions: SplashOptions = {};

  public get title(): string {
    return this._title;
  }

  public set title(value: string) {
    this._title = String(value ?? '');
    this._titleSource = this._title.trim().length > 0 ? 'user' : 'system';
  }

  public getTitleSource(): ConversationTitleSource {
    return this._titleSource;
  }

  public setSystemTitle(value: string): void {
    if (this._titleSource === 'user') return;
    this._title = String(value ?? '');
    this._titleSource = 'system';
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
    logConversationText(this.renderingContext(), this.getWidth(), text, style, indent);
  }

  /**
   * clearDisplay - Clear the visual history buffer without touching the LLM context messages.
   * The next render will show a blank conversation area.
   */
  public clearDisplay(): void {
    this.history.clear();
    this.appendedUpTo = 0;
    this.dirty = true;
    // Re-render from existing messages to rebuild buffer
    const width = this.getWidth();
    this.lastRenderedWidth = width;
    this.dirty = false;
    this.appendMessages(this.messages, width);
    this.appendedUpTo = this.messages.length;
  }

  /**
   * resetAll - Clear both the display buffer and all conversation messages.
   * This is a full reset; the LLM context is wiped.
   */
  public resetAll(): void {
    this.messages = [];
    this._title = '';
    this._titleSource = 'system';
    this.undoStack = [];
    this.branches.clear();
    this.currentBranch = 'main';
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
    this.collapseState.clear();
    this.blockRegistry = [];
    this.streamingStartLine = -1;
  }

  public getMessageSnapshot(): ConversationMessageSnapshot[] {
    return cloneMessages(this.messages);
  }

  public getTranscriptEventIndex() {
    return buildTranscriptEventIndex(this.getMessageSnapshot());
  }

  /**
   * replaceMessagesForLLM - Replace the conversation's LLM-visible messages with a new set.
   * Used by small-window compaction to swap in truncated messages without an LLM call.
   * System messages are always preserved at the front.
   *
   * @param newMessages - Replacement ProviderMessage array (user/assistant/tool roles only)
   */
  public replaceMessagesForLLM(newMessages: ProviderMessage[]): void {
    const originalSystemMessages = this.messages.filter(m => m.role === 'system');
    const convertedMessages = messagesToInternal(newMessages);
    this.messages = [...originalSystemMessages, ...convertedMessages];
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }

  /**
   * compact - Reduce conversation state to a structured handoff payload.
   *
   * @param registry - Provider registry
   * @param modelId - Model to use for summarization
   * @param trigger - 'manual' (from /compact command) or 'auto' (from threshold check)
   * @param provider - Provider name for model disambiguation
   * @param context - Structured compaction context
  */
  public async compact(
    registry: import('@pellux/goodvibes-sdk/platform/providers/registry').ProviderRegistry,
    modelId: string,
    trigger: 'auto' | 'manual' = 'manual',
    provider?: string,
    context?: import('./context-compaction.ts').CompactionContext,
  ): Promise<void> {
    return compactConversation(this, registry, modelId, trigger, provider, context);
  }

  /**
   * forkBranch - Save a deep-copy of the current messages under a named branch.
   * If no name is provided a timestamp-based name is used.
   * Returns the name used.
   */
  public forkBranch(name?: string, force = false): string {
    const branchName = name?.trim() || `branch-${Date.now()}`;
    if (!force && this.branches.has(branchName)) {
      logger.warn(`forkBranch: branch '${branchName}' already exists; use force=true to overwrite`);
    }
    this.branches.set(branchName, cloneMessages(this.messages));
    return branchName;
  }

  /**
   * listBranches - Return the names and message counts of all saved branches.
   */
  public listBranches(): Array<{ name: string; messageCount: number; isCurrent: boolean }> {
    const result: Array<{ name: string; messageCount: number; isCurrent: boolean }> = [];
    // Always include current branch even if it hasn't been stored in the map yet
    const currentInMap = this.branches.has(this.currentBranch);
    if (!currentInMap) {
      result.push({ name: this.currentBranch, messageCount: this.messages.length, isCurrent: true });
    }
    for (const [name, msgs] of this.branches) {
      result.push({ name, messageCount: msgs.length, isCurrent: name === this.currentBranch });
    }
    return result;
  }

  /**
   * switchBranch - Replace the active messages with the stored branch snapshot.
   * Returns true on success, false if the branch does not exist.
   */
  public switchBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    // Save current branch state before switching to prevent data loss
    this.branches.set(this.currentBranch, cloneMessages(this.messages));
    this.messages = cloneMessages(stored);
    this.currentBranch = name;
    this.undoStack = [];
    this.markDirty();
    return true;
  }

  /**
   * mergeBranch - Append all messages from the named branch that come after
   * the fork point (messages not already present in the current conversation).
   * Simple strategy: append all branch messages after current messages.
   * Returns true on success, false if the branch does not exist.
   */
  public mergeBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    // Use length-based fork point detection: the branch was cloned from a known
    // snapshot so we use the shorter of the two lengths as the common prefix,
    // then append any messages the branch has beyond that point.
    const commonLen = Math.min(this.messages.length, stored.length);
    const toAppend = stored.slice(commonLen);
    if (toAppend.length === 0) return true;
    this.messages.push(...cloneMessages(toAppend));
    this.undoStack = [];
    this.markDirty();
    return true;
  }

  /** Returns the name of the currently active branch. */
  public getCurrentBranch(): string {
    return this.currentBranch;
  }

  /**
   * toJSON - Serialize conversation for persistence.
   */
  public toJSON(): object {
    // Serialize branches map as a plain object for persistence
    const branchesObj = cloneBranchMap(this.branches);
    return {
      messages: cloneMessages(this.messages),
      timestamp: Date.now(),
      title: this._title,
      titleSource: this._titleSource,
      branches: branchesObj,
      currentBranch: this.currentBranch,
    };
  }

  /**
   * fromJSON - Restore conversation from persisted data.
   */
  public fromJSON(data: { messages: Message[]; branches?: Record<string, Message[]>; currentBranch?: string; title?: string; titleSource?: ConversationTitleSource }): void {
    this.messages = data.messages ?? [];
    this._title = typeof data.title === 'string' ? data.title : '';
    this._titleSource = data.titleSource === 'user' || data.titleSource === 'system'
      ? data.titleSource
      : (this._title ? 'user' : 'system');
    this.branches = restoreBranchMap(data.branches);
    this.currentBranch = data.currentBranch ?? 'main';
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }
}
export { parseDiffForApply, applyDiffContent } from './conversation-diff';
