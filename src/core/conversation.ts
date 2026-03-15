import { InfiniteBuffer } from './history.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { renderMarkdown } from '../renderer/markdown.ts';
import { renderToolCallBlock } from '../renderer/tool-call.ts';
import { createEmptyLine, type Line, type Cell } from '../types/grid.ts';
import { getSplashLines, type SplashOptions } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import type { ProviderMessage, ContentPart } from '../providers/interface.ts';
import { logger } from '../utils/logger.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ConfigManager } from '../config/manager.ts';

/** Rough token estimate: 4 chars ≈ 1 token. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * ConversationManager - Owns conversation messages and the rendered history buffer.
 * Supports tool-use messages (assistant with tool calls, tool results).
 *
 * History is rebuilt lazily: a dirty flag is set on every message mutation and
 * the buffer is only actually reconstructed when getDisplayBlocks() is called
 * or when the width changes. This avoids O(n) rebuilds per turn in long sessions.
 */
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

type AssistantMessage = { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoningContent?: string; reasoningSummary?: string; usage?: TokenUsage };

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
  /** Streaming block start line in history buffer (for incremental streaming update). */
  private streamingStartLine = -1;
  /** Undo stack: each entry is a turn (user msg + all subsequent non-user msgs until next user). */
  private undoStack: Message[][] = [];

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
    // Extract plain text for title generation and display
    const textContent = typeof content === 'string'
      ? content
      : content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('');
    if (this.title === '') {
      // Auto-generate title from first user message (max 50 chars, truncated at word boundary)
      if (textContent.length <= 50) {
        this.title = textContent;
      } else {
        const truncated = textContent.slice(0, 50);
        const lastSpace = truncated.lastIndexOf(' ');
        this.title = lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
      }
    }
    this.messages.push({ role: 'user', content });
    // Clear undo stack when new user input is added (can't redo past new input)
    this.undoStack = [];
    this.markDirty();
  }

  /** Add an assistant message, optionally with tool calls (when the LLM invoked tools). */
  public addAssistantMessage(content: string, opts?: { toolCalls?: ToolCall[]; reasoningContent?: string; reasoningSummary?: string; usage?: TokenUsage }): void {
    this.messages.push({ role: 'assistant', content, toolCalls: opts?.toolCalls, reasoningContent: opts?.reasoningContent, reasoningSummary: opts?.reasoningSummary, usage: opts?.usage });
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
    const width = this.getWidth();
    this.lastRenderedWidth = width;
    this.dirty = false;

    // Tool messages ARE rendered (as collapsed blocks); this filter is only
    // for determining whether to show the splash screen (tool-only messages
    // don't count as visible conversation content for splash purposes).
    const displayMessages = this.messages.filter(
      (m) => m.role !== 'tool',
    );

    if (displayMessages.length === 0) {
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
    if (!this.dirty) return;
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
        const displayText = typeof m.content === 'string'
          ? m.content
          : (m.content as ContentPart[])
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text)
              .join('')
            + ((m.content as ContentPart[]).filter(p => p.type === 'image').length > 0
              ? ` [+${(m.content as ContentPart[]).filter(p => p.type === 'image').length} image(s)]`
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
          const thinkingHeader = this.textToLines('💭 Thinking:', width, { fg: '238', dim: true, italic: true });
          this.history.addLines(thinkingHeader);
          const thinkingLines = this.textToLines(m.reasoningContent, width, { fg: '238', dim: true, italic: true });
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
          const summaryHeader = this.textToLines('🧠 Reasoning Summary:', width, { fg: '238', dim: true, italic: true });
          this.history.addLines(summaryHeader);
          const summaryLines = this.textToLines(m.reasoningSummary, width, { fg: '238', dim: true, italic: true });
          this.history.addLines(summaryLines);
          this.history.addLine(createEmptyLine(width));
        }
        // Render assistant content using the markdown renderer
        if (m.content) {
          const rendered = renderMarkdown(m.content, width);
          if (showLineNumbers) {
            // Prepend dimmed 4-char gutter: '  1 |', '  2 |', etc.
            const numbered = rendered.map((line, i) => {
              const label = String(i + 1).padStart(3) + ' |';
              const gutterLine = UIFactory.stringToLine(label, width, { fg: '238', dim: true });
              // Overlay gutter at start of line (first 5 cells)
              const combined = [...line];
              for (let ci = 0; ci < Math.min(5, gutterLine.length, combined.length); ci++) {
                combined[ci] = gutterLine[ci];
              }
              return combined;
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
        const lines = this.textToLines(m.content, width, { fg: '196' });
        this.history.addLines(lines);
      } else if (m.role === 'tool') {
        // Collapsible tool result block
        // Use the message's index in this.messages as a stable collapse key
        const msgIndex = this.messages.indexOf(m);
        const collapseKey = `msg_${msgIndex >= 0 ? msgIndex : msgIdx}`;
        const blockIdx = this.blockRegistry.length;
        const startLine = this.history.getLineCount();
        const contentLines = m.content.split('\n');
        const lineCount = contentLines.length;
        const hasDiffHeader = contentLines.some(l => l.startsWith('--- ')) && contentLines.some(l => l.startsWith('+++ '));
        const hasHunk = contentLines.some(l => l.startsWith('@@ '));
        const isDiff = hasDiffHeader && hasHunk;
        const blockType: 'diff' | 'tool' = isDiff ? 'diff' : 'tool';

        // Auto-collapse tool results by default (unless explicitly expanded)
        const isCollapsed = this.collapseState.has(collapseKey)
          ? this.collapseState.get(collapseKey)!
          : lineCount > collapseThreshold;

        // Set default collapse state
        if (!this.collapseState.has(collapseKey) && lineCount > collapseThreshold) {
          this.collapseState.set(collapseKey, true);
        }

        if (isCollapsed) {
          // Show header line + collapsed indicator
          const preview = contentLines[0].slice(0, width - 30);
          const hiddenCount = lineCount - 1;
          const collapsedText = hiddenCount > 0
            ? `[tool result] ${preview}…  [+${hiddenCount} lines — Tab to expand]`
            : `[tool result] ${preview}`;
          const lines = this.textToLines(collapsedText, width, { fg: '244', dim: true });
          this.history.addLines(lines);
        } else {
          // Show full content (no truncation when expanded)
          const expandedLines = this.textToLines(`[tool result] ${m.content}`, width, { fg: '244', dim: true });
          this.history.addLines(expandedLines);
        }

        // Register this block for copy/apply
        const renderedLineCount = this.history.getLineCount() - startLine;
        let meta: BlockMeta = {
          blockIndex: blockIdx,
          collapseKey,
          type: blockType,
          startLine,
          lineCount: renderedLineCount,
          rawContent: m.content,
        };

        // Parse diff for apply
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

  /** Options passed to the splash screen renderer. Set externally. */
  /** Returns a read-only view of the block registry for external consumers. */
  public getBlockRegistry(): readonly BlockMeta[] {
    return this.blockRegistry;
  }

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
    const tabWidth = 4;
    const contentWidth = width - tabWidth - 2;
    const wrapped = wrapText(text, contentWidth);

    return wrapped.map((l, i) => {
      const prefix = i === 0 ? '>   ' : '    ';
      return UIFactory.stringToLine(prefix + l, width, style);
    });
  }

  public log(text: string, style: Partial<Cell> = {}, indent = '  '): void {
    const width = this.getWidth();
    const lines = text.split('\n').map((l, i) =>
      UIFactory.stringToLine((i === 0 ? l : indent + l), width, style)
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
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
    this.collapseState.clear();
    this.blockRegistry = [];
    this.streamingStartLine = -1;
  }

  /**
   * estimateTotalTokens - Rough estimate of tokens in all messages.
   * Uses 4-chars-per-token heuristic.
   */
  public estimateTotalTokens(): number {
    return this.messages.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + estimateTokens(m.content);
      // ContentPart[] — sum text parts only (images add tokens via visual encoding, rough estimate)
      const textContent = (m.content as ContentPart[])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('');
      const imageCount = (m.content as ContentPart[]).filter(p => p.type === 'image').length;
      return sum + estimateTokens(textContent) + imageCount * 1000; // ~1000 tokens per image rough estimate
    }, 0);
  }

  /**
   * compact - Summarize the conversation to free context window.
   * Sends a summarization prompt to the LLM and replaces message history
   * with the summary as a single system message.
   */
  public async compact(registry: ProviderRegistry, modelId: string): Promise<void> {
    if (this.messages.length === 0) return;

    const fullText = this.messages
      .filter(m => m.role !== 'system')
      .map(m => {
        const role = m.role === 'tool' ? 'tool-result' : m.role;
        const contentText = typeof m.content === 'string'
          ? m.content
          : (m.content as ContentPart[]).filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('');
        return `[${role}]: ${contentText}`;
      })
      .join('\n\n');

    const prompt = [
      'Please provide a concise summary of the following conversation.',
      'Include: key topics discussed, decisions made, files modified, and current state.',
      'Format as bullet points. Be terse.',
      '',
      fullText,
    ].join('\n');

    try {
      const provider = registry.getForModel(modelId);
      const response = await provider.chat({
        messages: [{ role: 'user', content: prompt }],
        model: modelId,
      });
      const summary = response.content;

      if (summary) {
        // Replace all messages with the summary
        this.messages = [
          { role: 'system', content: `[Conversation summary]\n${summary}` },
        ];
        this.history.clear();
        this.appendedUpTo = 0;
        this.lastRenderedWidth = 0;
        this.dirty = true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Compact failed', { error: msg });
    }
  }

  /**
   * toJSON - Serialize conversation for persistence.
   */
  public toJSON(): object {
    return { messages: structuredClone(this.messages), timestamp: Date.now() };
  }

  /**
   * fromJSON - Restore conversation from persisted data.
   */
  public fromJSON(data: { messages: Message[] }): void {
    this.messages = data.messages ?? [];
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
