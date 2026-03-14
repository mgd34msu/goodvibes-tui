import { InfiniteBuffer } from './history.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { createEmptyLine } from '../types/grid.ts';
import { getSplashLines } from '../utils/splash-lines.ts';
import { type Line, type Cell } from '../types/grid.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import type { ProviderMessage } from '../providers/interface.ts';

/**
 * ConversationManager - Owns conversation messages and the rendered history buffer.
 * Supports tool-use messages (assistant with tool calls, tool results).
 *
 * History is rebuilt lazily: a dirty flag is set on every message mutation and
 * the buffer is only actually reconstructed when getDisplayBlocks() is called
 * or when the width changes. This avoids O(n) rebuilds per turn in long sessions.
 */
type Message =
  | { role: 'user'; content: string }
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

  public addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
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
  private flushHistory(): void {
    if (!this.dirty) return;

    const width = this.getWidth();

    if (width !== this.lastRenderedWidth || this.appendedUpTo > this.messages.length) {
      // Width changed or messages were removed — must do a full rebuild
      this.rebuildHistory();
      return;
    }

    // Splash screen case: if we had no messages before and now we do, rebuild
    const hadNoMessages = this.appendedUpTo === 0;
    if (hadNoMessages && this.messages.length > 0) {
      this.rebuildHistory();
      return;
    }

    // Append only the new messages
    const newMessages = this.messages.slice(this.appendedUpTo);
    this.appendMessages(newMessages, width);
    this.appendedUpTo = this.messages.length;
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  /** Render a slice of messages into the history buffer. */
  private appendMessages(messages: Message[], width: number): void {
    for (const m of messages) {
      if (m.role === 'user') {
        this.history.addLines(UIFactory.createMessageBar(width, m.content));
      } else if (m.role === 'assistant') {
        // Show tool calls as a brief indicator
        if (m.toolCalls && m.toolCalls.length > 0 && !m.content) {
          const toolNames = m.toolCalls.map((tc) => tc.name).join(', ');
          const indicator = this.textToLines(`[calling tools: ${toolNames}]`, width, { fg: '244', dim: true });
          this.history.addLines(indicator);
        } else if (m.content) {
          const lines = this.textToLines(m.content, width, { fg: '15' });
          this.history.addLines(lines);
          // If there were also tool calls, show the indicator after content
          if (m.toolCalls && m.toolCalls.length > 0) {
            const toolNames = m.toolCalls.map((tc) => tc.name).join(', ');
            const indicator = this.textToLines(`[called tools: ${toolNames}]`, width, { fg: '244', dim: true });
            this.history.addLines(indicator);
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

  private addSplashScreen(width: number): void {
    const splashStrings = getSplashLines(width);
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
}
