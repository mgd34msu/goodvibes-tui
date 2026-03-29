import { InfiniteBuffer } from './history.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { renderMarkdown, renderMarkdownTracked } from '../renderer/markdown.ts';
import { renderToolCallBlock } from '../renderer/tool-call.ts';
import { renderThinkingBlock } from '../renderer/thinking.ts';
import { renderSystemMessage } from '../renderer/system-message.ts';
import { createEmptyLine, type Line, type Cell } from '../types/grid.ts';
import { getSplashLines, type SplashOptions } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import type { ProviderMessage, ContentPart } from '../providers/interface.ts';
import { logger } from '../utils/logger.ts';
import { LAYOUT } from '../renderer/layout.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ConfigManager } from '../config/manager.ts';
import { compactMessages, estimateConversationTokens } from './context-compaction.ts';

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

type Message =
  | { role: 'user'; content: string | ContentPart[]; cancelled?: boolean }
  | AssistantMessage
  | { role: 'system'; content: string }
  | { role: 'tool'; callId: string; content: string; toolName?: string };

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
  public title = '';
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
  /** Collapse state: stable key (msg_N) -> collapsed (true = collapsed). */
  private collapseState: Map<string, boolean> = new Map();
  /** Block registry: track rendered blocks for copy/apply. */
  protected blockRegistry: BlockMeta[] = [];
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
        result.push({ role: 'tool', callId: m.callId, content: m.content });
      }
    }
    return result;
  }

  public addUserMessage(content: string | ContentPart[]): void {
    // Title is only set explicitly via /session rename — no auto-generation
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
      this.messages.push({ role: 'tool', callId: r.callId, content });
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

  /** Render a slice of messages into the history buffer. */
  private appendMessages(messages: Message[], width: number): void {
    const showLineNumbers = this.configManager?.get('display.lineNumbers') ?? false;
    const collapseThreshold = this.configManager?.get('display.collapseThreshold') ?? 30;

    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      const m = messages[msgIdx];
      if (m.role === 'user') {
        // Flatten ContentPart[] to display text for user messages
        const parts = Array.isArray(m.content) ? m.content as ContentPart[] : [];
        const displayText = typeof m.content === 'string'
          ? m.content
          : parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('')
            + (parts.filter(p => p.type === 'image').length > 0
              ? ` [+${parts.filter(p => p.type === 'image').length} image(s)]`
              : '');
        if (m.cancelled) {
          this.history.addLines(UIFactory.createMessageBar(width, displayText, '#3a1a1a', '196', ' × ', true));
        } else {
          this.history.addLines(UIFactory.createMessageBar(width, displayText));
        }
      } else if (m.role === 'assistant') {
        // Render reasoning/thinking block if enabled and present
        const showThinking = this.configManager?.get('display.showThinking') ?? false;
        const showReasoningSummary = this.configManager?.get('display.showReasoningSummary') ?? false;
        if (showThinking && m.reasoningContent) {
          const thinkingStartLine = this.history.getLineCount();
          const thinkingBlockIdx = this.blockRegistry.length;
          const thinkingCollapseKey = `msg_${msgIdx}_thinking`;
          const thinkingLines = renderThinkingBlock(m.reasoningContent, width);
          this.history.addLines(thinkingLines);
          this.history.addLine(createEmptyLine(width));
          const thinkingRenderedLines = this.history.getLineCount() - thinkingStartLine;
          this.blockRegistry.push({
            blockIndex: thinkingBlockIdx,
            collapseKey: thinkingCollapseKey,
            type: 'thinking',
            startLine: thinkingStartLine,
            lineCount: thinkingRenderedLines,
            rawContent: m.reasoningContent,
          });
        }
        if (showReasoningSummary && m.reasoningSummary) {
          const summaryLines = renderThinkingBlock(m.reasoningSummary, width);
          this.history.addLines(summaryLines);
          this.history.addLine(createEmptyLine(width));
        }
        // Render model label if present (dim, above content)
        if (m.model) {
          const labelText = m.provider ? `${m.model} (${m.provider})` : m.model;
          const labelLine = createEmptyLine(width);
          const labelStr = ' '.repeat(LAYOUT.LEFT_MARGIN) + labelText;
          for (let ci = 0; ci < labelStr.length && ci < width; ci++) {
            labelLine[ci] = { char: labelStr[ci], fg: '238', bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false };
          }
          this.history.addLine(labelLine);
        }
        // Render assistant content using the markdown renderer
        if (m.content) {
          // Calculate gutter width dynamically based on total line count
          const preRendered = showLineNumbers ? renderMarkdown(m.content, width) : null;
          const totalLines = preRendered?.length ?? 0;
          const numWidth = Math.max(3, String(totalLines).length); // minimum 3 digits wide
          const gutterW = numWidth + 3; // digits + ' │ '
          const contentWidth = showLineNumbers ? width - gutterW : width;
          const renderWidth = showLineNumbers ? contentWidth : width;

          // Use tracked render to register code blocks in blockRegistry
          const { lines: tracked, codeBlocks } = renderMarkdownTracked(m.content, renderWidth);

          // Register each code block found in this message
          const msgBaseLineOffset = this.history.getLineCount();
          for (const cb of codeBlocks) {
            const blockStartLine = msgBaseLineOffset + cb.startOffset;
            const blockIdx = this.blockRegistry.length;
            const collapseKey = `code_${msgIdx}_${blockIdx}`;
            const isAutoCollapsed = cb.rawContent.split('\n').length > collapseThreshold;
            if (isAutoCollapsed && !this.collapseState.has(collapseKey)) {
              this.collapseState.set(collapseKey, true);
            }
            this.blockRegistry.push({
              blockIndex: blockIdx,
              collapseKey,
              type: 'code',
              startLine: blockStartLine,
              lineCount: cb.lineCount,
              rawContent: cb.rawContent,
            });
          }

          const rendered = tracked;
          if (showLineNumbers) {
            // Prepend dimmed gutter and shift content right
            const numbered = rendered.map((line, i) => {
              const label = String(i + 1).padStart(numWidth) + ' \u2502 ';
              const gutterCells = UIFactory.stringToLine(label, gutterW, { fg: '238', dim: true });
              // Build full-width line: gutter + content
              const fullLine = createEmptyLine(width);
              for (let ci = 0; ci < gutterW && ci < gutterCells.length; ci++) {
                fullLine[ci] = gutterCells[ci];
              }
              for (let ci = 0; ci < line.length && gutterW + ci < width; ci++) {
                fullLine[gutterW + ci] = line[ci];
              }
              return fullLine;
            });
            this.history.addLines(numbered);
          } else {
            this.history.addLines(rendered);
          }
        }
        // Render tool calls using the tool-call block renderer
        if (m.toolCalls && m.toolCalls.length > 0) {
          for (const tc of m.toolCalls) {
            const status = 'done'; // Historical messages are always complete
            this.history.addLines(renderToolCallBlock(tc, status, undefined, width));
          }
        }
      } else if (m.role === 'system') {
        const sysStartLine = this.history.getLineCount();
        const sysLines = renderSystemMessage(m.content, width);
        this.history.addLines(sysLines);
        if (/error/i.test(m.content)) {
          this.errorLineRegistry.push(sysStartLine);
        }
      } else if (m.role === 'tool') {
        const collapseKey = `msg_${msgIdx}`;
        const blockIdx = this.blockRegistry.length;
        const startLine = this.history.getLineCount();
        const contentLines = m.content.split('\n');
        const lineCount = contentLines.length;
        const hasDiffHeader = contentLines.some(l => l.startsWith('--- ')) && contentLines.some(l => l.startsWith('+++ '));
        const hasHunk = contentLines.some(l => l.startsWith('@@ '));
        const isDiff = hasDiffHeader && hasHunk;
        const blockType: 'diff' | 'tool' = isDiff ? 'diff' : 'tool';

        // Short messages (≤200 chars) are never collapsible
        const isShort = m.content.length <= 200;
        const isCollapsed = isShort ? false
          : this.collapseState.has(collapseKey)
            ? this.collapseState.get(collapseKey)!
            : true;  // Collapsed by default

        if (!this.collapseState.has(collapseKey)) {
          this.collapseState.set(collapseKey, isShort ? false : true);
        }

        if (isCollapsed) {
          // Collapsed: single dim line with preview
          const COLLAPSE_SUFFIX_RESERVE = 30; // space for '… [+N lines]' suffix
          const preview = contentLines[0].slice(0, width - LAYOUT.LEFT_MARGIN - LAYOUT.RIGHT_MARGIN - COLLAPSE_SUFFIX_RESERVE);
          const hiddenCount = lineCount - 1;
          const collapsedText = hiddenCount > 0
            ? `${preview}…  [+${hiddenCount} lines]`
            : preview;
          const rendered = renderSystemMessage(collapsedText, width, 'info');
          this.history.addLines(rendered);
        } else {
          // Expanded: render through markdown pipeline
          let contentToRender = m.content;

          // If the content is valid JSON, wrap in a json code fence for syntax highlighting
          const trimmed = contentToRender.trimStart();
          if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && contentToRender.length < 100_000) {
            try {
              const parsed = JSON.parse(contentToRender);
              contentToRender = '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
            } catch {
              // Not valid JSON — render as-is through markdown
            }
          }

          const rendered = renderMarkdown(contentToRender, width);
          this.history.addLines(rendered);
        }

        const renderedLineCount = this.history.getLineCount() - startLine;
        let meta: BlockMeta = {
          blockIndex: blockIdx,
          collapseKey,
          type: blockType,
          startLine,
          lineCount: renderedLineCount,
          rawContent: m.content,
        };

        if (isDiff) {
          meta = { ...meta, ...parseDiffForApply(m.content) };
        }

        this.blockRegistry.push(meta);
      }
      this.history.addLine(createEmptyLine(width));
    }
  }

  /** Find the nearest block to a given line index, optionally filtered by type. */
  public findNearestBlock(lineIndex: number, typeFilter?: string): BlockMeta | null {
    let nearest: BlockMeta | null = null;
    let nearestDist = Infinity;
    for (const block of this.blockRegistry) {
      if (typeFilter !== undefined && block.type !== typeFilter) continue;
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

  public suppressSplash: boolean = false;
  public splashOptions: SplashOptions = {};

  private addSplashScreen(width: number): void {
    const splashStrings = getSplashLines(width, this.splashOptions);
    const CYAN = '#00ffff';
    const PURPLE = '#d000ff';
    const GREY = '244';

    splashStrings.forEach((str, y) => {
      const line = UIFactory.stringToLine(str, width);
      const isVersion = y === splashStrings.length - 1;
      const startX = Math.floor((width - getDisplayWidth(str)) / 2);
      const endX = startX + getDisplayWidth(str);

      for (let x = 0; x < width; x++) {
        const cell = line[x];
        if (cell.char === ' ' && (x < startX || x >= endX)) continue;
        if (isVersion) {
          cell.fg = GREY;
          cell.dim = true;
        } else {
          const factor = (x - startX) / (endX - startX || 1);
          cell.fg = interpolateColor(CYAN, PURPLE, Math.max(0, Math.min(1, factor)));
          cell.bold = true;
        }
      }
      this.history.addLine(line);
    });
    this.history.addLine(createEmptyLine(width));
    this.history.addLine(createEmptyLine(width));
    this.history.addLine(createEmptyLine(width));
    this.history.addLine(createEmptyLine(width));
    this.history.addLine(createEmptyLine(width));
  }

  public textToLines(text: string, width: number, style: Partial<Cell> = {}): Line[] {
    const contentWidth = LAYOUT.contentWidth(width);
    const wrapped = wrapText(text, contentWidth);

    return wrapped.map((l, i) => {
      const prefix = i === 0 ? '>' + ' '.repeat(LAYOUT.LEFT_MARGIN - 1) : ' '.repeat(LAYOUT.LEFT_MARGIN);
      return UIFactory.stringToLine(prefix + l, width, style);
    });
  }

  public log(text: string, style: Partial<Cell> = {}, indent = ' '.repeat(LAYOUT.LEFT_MARGIN)): void {
    const width = this.getWidth();
    const lines = text.split('\n').map((l) =>
      UIFactory.stringToLine(indent + l, width, style)
    );
    this.history.addLines(lines);
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
    this.title = '';
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


  /**
   * compact - Summarize the conversation to free context window.
   *
   * Uses context-compaction strategy:
   *   - Preserves the last N messages verbatim (default: 10)
   *   - Summarizes all older assistant/user/tool messages into bullet-point form
   *   - Keeps system messages at the front
   *
   * @param registry - Provider registry
   * @param modelId - Model to use for summarization
   * @param keepRecentMessages - Number of recent messages to preserve verbatim (default: 10)
   * @param trigger - 'manual' (from /compact command) or 'auto' (from threshold check)
   */
  public async compact(
    registry: ProviderRegistry,
    modelId: string,
    keepRecentMessages = 10,
    trigger: 'auto' | 'manual' = 'manual',
    provider?: string,
  ): Promise<void> {
    if (this.messages.length === 0) return;

    try {
      const llmMessages = this.getMessagesForLLM();
      const result = await compactMessages({
        registry,
        modelId,
        provider,
        messages: llmMessages,
        keepRecentMessages,
        trigger,
      });

      // Rebuild internal messages from the compacted LLM-format messages.
      // ProviderMessage only has 'user', 'assistant', 'tool' roles (no 'system').
      // Preserve any original system messages from before compaction, then add compacted messages.
      const originalSystemMessages = this.messages.filter(m => m.role === 'system');
      const compactedMessages = result.messages.map(m => {
        if (m.role === 'user') {
          return { role: 'user' as const, content: typeof m.content === 'string' ? m.content : (m.content as ContentPart[]) };
        }
        if (m.role === 'assistant') {
          const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as { type: string; text?: string }[]).filter(p => p.type === 'text').map(p => p.text ?? '').join('')
              : String(m.content);
          return { role: 'assistant' as const, content: text };
        }
        // tool role
        const toolMsg = m as { role: 'tool'; callId: string; content: string; name?: string };
        return { role: 'tool' as const, callId: toolMsg.callId ?? '', content: typeof toolMsg.content === 'string' ? toolMsg.content : String(toolMsg.content) };
      });
      this.messages = [...originalSystemMessages, ...compactedMessages];

      this.history.clear();
      this.appendedUpTo = 0;
      this.lastRenderedWidth = 0;
      this.dirty = true;

      const saved = result.tokensBeforeEstimate - result.tokensAfterEstimate;
      logger.info('Conversation compacted', {
        trigger,
        messagesBeforeCompaction: result.event.messagesBeforeCompaction,
        messagesAfterCompaction: result.event.messagesAfterCompaction,
        tokensBeforeEstimate: result.tokensBeforeEstimate,
        tokensAfterEstimate: result.tokensAfterEstimate,
        tokensSaved: saved,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Compact failed', { error: msg });
      throw err;
    }
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
    this.branches.set(branchName, structuredClone(this.messages));
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
    this.branches.set(this.currentBranch, structuredClone(this.messages));
    this.messages = structuredClone(stored);
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
    this.messages.push(...structuredClone(toAppend));
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
    const branchesObj: Record<string, Message[]> = {};
    for (const [name, msgs] of this.branches) {
      branchesObj[name] = structuredClone(msgs);
    }
    return {
      messages: structuredClone(this.messages),
      timestamp: Date.now(),
      branches: branchesObj,
      currentBranch: this.currentBranch,
    };
  }

  /**
   * fromJSON - Restore conversation from persisted data.
   */
  public fromJSON(data: { messages: Message[]; branches?: Record<string, Message[]>; currentBranch?: string }): void {
    this.messages = data.messages ?? [];
    // Restore branch snapshots if present
    this.branches.clear();
    if (data.branches) {
      for (const [name, msgs] of Object.entries(data.branches)) {
        this.branches.set(name, msgs);
      }
    }
    this.currentBranch = data.currentBranch ?? 'main';
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }
}

/**
 * parseDiffForApply - Extract file path, original, and updated content from a unified diff.
 * Returns partial BlockMeta fields for diff blocks.
 */
export function parseDiffForApply(diffText: string): Pick<BlockMeta, 'filePath' | 'diffOriginal' | 'diffUpdated'> {
  const lines = diffText.split('\n');
  let filePath: string | undefined;

  // Extract file path from +++ line
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      // '+++ b/src/foo.ts' or '+++ src/foo.ts (updated)'
      const raw = line.slice(4).trim();
      const path = raw.startsWith('b/') ? raw.slice(2) : raw.split(' ')[0];
      if (path && path !== '/dev/null') filePath = path;
      break;
    }
  }

  // Build original and updated from diff hunks
  const originalLines: string[] = [];
  const updatedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      updatedLines.push(line.slice(1));
    } else {
      // Context line — belongs to both
      const content = line.startsWith(' ') ? line.slice(1) : line;
      originalLines.push(content);
      updatedLines.push(content);
    }
  }

  return {
    filePath,
    diffOriginal: originalLines.join('\n'),
    diffUpdated: updatedLines.join('\n'),
  };
}

/**
 * applyDiffContent - Apply a diff's original→updated replacement to file content.
 * Returns the new content on success, or an error string if the pattern is not found
 * or is ambiguous (appears more than once).
 */
export function applyDiffContent(
  fileContent: string,
  original: string,
  updated: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!original) {
    return { ok: false, error: 'empty original pattern' };
  }
  if (!fileContent.includes(original)) {
    return { ok: false, error: 'original text not found in file' };
  }
  const occurrenceCount = fileContent.split(original).length - 1;
  if (occurrenceCount > 1) {
    return { ok: false, error: `ambiguous: pattern found ${occurrenceCount} times` };
  }
  return { ok: true, content: fileContent.replace(original, updated) };
}
