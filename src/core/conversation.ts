import { InfiniteBuffer } from './history.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { renderMarkdown } from '../renderer/markdown.ts';
import { renderToolCallBlock } from '../renderer/tool-call.ts';
import { createEmptyLine, type Line, type Cell } from '../types/grid.ts';
import { getSplashLines, type SplashOptions } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import type { ProviderMessage } from '../providers/interface.ts';
import { logger } from '../utils/logger.ts';
import type { ProviderRegistry } from '../providers/registry.ts';

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
type Message =
  | { role: 'user'; content: string; cancelled?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'system'; content: string }
  | { role: 'tool'; callId: string; content: string; toolName?: string };

export class ConversationManager {
  public history = new InfiniteBuffer();
  private messages: Message[] = [];
  private getWidth: () => number;
  /** Tracks the rendered width; a change invalidates the full history. */
  private lastRenderedWidth = 0;
  /** When true the buffer needs to be rebuilt before the next display. */
  private dirty = true;
  /** Index of the first message not yet appended to the buffer. */
  private appendedUpTo = 0;

  constructor(getWidth: () => number = () => process.stdout.columns || 80) {
    this.getWidth = getWidth;
  }

  /** Returns messages formatted for LLM provider consumption. */
  public getMessagesForLLM(): ProviderMessage[] {
    const result: ProviderMessage[] = [];
    for (const m of this.messages) {
      if (m.role === 'system') continue; // System messages go via systemPrompt param
      if (m.role === 'user') {
        result.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        result.push({ role: 'assistant', content: m.content, toolCalls: m.toolCalls });
      } else if (m.role === 'tool') {
        result.push({ role: 'tool', callId: m.callId, content: m.content });
      }
    }
    return result;
  }

  public addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
    this.markDirty();
  }

  /** Add an assistant message, optionally with tool calls (when the LLM invoked tools). */
  public addAssistantMessage(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({ role: 'assistant', content, toolCalls });
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
  }

  /**
   * updateStreamingBlock - Update the in-progress streaming block with accumulated content.
   * Called per-delta during streaming.
   */
  public updateStreamingBlock(content: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        (this.messages[i] as { role: 'assistant'; content: string }).content = content;
        this.markDirty();
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
    const width = this.getWidth();
    this.lastRenderedWidth = width;
    this.dirty = false;

    const displayMessages = this.messages.filter(
      (m) => m.role !== 'tool', // Tool results are internal; not shown directly
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
    for (const m of messages) {
      if (m.role === 'user') {
        if (m.cancelled) {
          this.history.addLines(UIFactory.createMessageBar(width, m.content, '#3a1a1a', '196', ' × ', true));
        } else {
          this.history.addLines(UIFactory.createMessageBar(width, m.content));
        }
      } else if (m.role === 'assistant') {
        // Render assistant content using the markdown renderer
        if (m.content) {
          const lines = renderMarkdown(m.content, width);
          this.history.addLines(lines);
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
        // Show tool results collapsed
        const content = m.content.length > 200 ? m.content.slice(0, 200) + '\u2026' : m.content;
        const lines = this.textToLines(`[tool result] ${content}`, width, { fg: '244', dim: true });
        this.history.addLines(lines);
      }
      this.history.addLine(createEmptyLine(width));
    }
  }

  /** Options passed to the splash screen renderer. Set externally. */
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
    this.history.clear();
    this.appendedUpTo = 0;
    this.lastRenderedWidth = 0;
    this.dirty = true;
  }

  /**
   * estimateTotalTokens - Rough estimate of tokens in all messages.
   * Uses 4-chars-per-token heuristic.
   */
  public estimateTotalTokens(): number {
    return this.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
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
        return `[${role}]: ${m.content}`;
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
    return { messages: this.messages, timestamp: Date.now() };
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
