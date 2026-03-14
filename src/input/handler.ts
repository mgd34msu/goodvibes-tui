import { InputTokenizer } from '../core/tokenizer.ts';
import { SelectionManager } from './selection.ts';
import { copyToClipboard, pasteFromClipboard } from '../utils/clipboard.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InfiniteBuffer } from '../core/history.ts';

/**
 * InputHandler - Owns prompt text, paste registry, and keyboard/mouse handling.
 * Extracted from main.ts and StateManager.
 */
export class InputHandler {
  public prompt = '';
  public showExitNotice = false;
  public lastCopyTime = 0;

  private tokenizer = new InputTokenizer();
  private pasteRegistry = new Map<string, string>();
  private nextPasteId = 1;
  private lastCtrlCTime = 0;

  constructor(
    private bus: EventBus,
    private selection: SelectionManager,
    private getScrollTop: () => number,
    private getViewportHeight: () => number,
    private getHistory: () => InfiniteBuffer,
    private scroll: (delta: number) => void,
    private exitApp: () => void,
  ) {}

  /**
   * registerPaste - Stores multi-line content and returns a visual marker string.
   */
  public registerPaste(content: string): string {
    const lines = content.split('\n');
    if (lines.length <= 8) return content;
    const id = `p${this.nextPasteId++}`;
    this.pasteRegistry.set(id, content);
    return `[PASTE:${id} (${lines.length} lines)]`;
  }

  /**
   * expandPrompt - Replaces paste markers with actual content.
   */
  private expandPrompt(text: string): string {
    const foundIds = new Set<string>();
    const markerRegex = /\[PASTE:(p\d+) \(\d+ lines\)\]/g;

    const replacements: { marker: string; index: number; content: string; id: string }[] = [];
    let match;
    while ((match = markerRegex.exec(text)) !== null) {
      const id = match[1];
      const content = this.pasteRegistry.get(id);
      if (content) {
        replacements.push({ marker: match[0], index: match.index, content, id });
        foundIds.add(id);
      }
    }

    let expanded = text;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { marker, index, content } = replacements[i];
      expanded = expanded.slice(0, index) + content + expanded.slice(index + marker.length);
    }

    for (const id of this.pasteRegistry.keys()) {
      if (!foundIds.has(id)) {
        this.pasteRegistry.delete(id);
      }
    }

    return expanded;
  }

  private handleCopy(): void {
    if (this.selection.hasSelection()) {
      copyToClipboard(this.selection.getSelectedText(this.getHistory()));
      this.lastCopyTime = Date.now();
      this.bus.emit('render:request');
      setTimeout(() => this.bus.emit('render:request'), 2005);
    }
  }

  private handleCtrlC(): void {
    const now = Date.now();
    if (now - this.lastCtrlCTime < 1000) {
      this.exitApp();
    } else {
      this.lastCtrlCTime = now;
      this.showExitNotice = true;
      this.bus.emit('render:request');
      setTimeout(() => {
        this.showExitNotice = false;
        this.bus.emit('render:request');
      }, 1000);
    }
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

    for (const token of tokens) {
      if (token.type === 'text') {
        this.prompt += this.registerPaste(token.value);
      } else if (token.type === 'key') {
        if (token.logicalName === 'c' && token.ctrl && token.shift) {
          this.handleCopy();
          continue;
        }
        if (token.logicalName === 'c' && token.ctrl && !token.shift) {
          this.handleCtrlC();
          continue;
        }
        if (token.logicalName === 'enter') {
          if (token.shift) {
            this.prompt += '\n';
          } else {
            const text = this.prompt.trim();
            if (text === ':q') {
              this.exitApp();
              return;
            }
            if (text) {
              this.prompt = '';
              const fullText = this.expandPrompt(text);
              this.bus.emit('input:submit', { text: fullText });
            }
          }
          continue;
        }

        if (token.logicalName === 'backspace') {
          this.prompt = this.prompt.slice(0, -1);
        } else if (token.logicalName === 'up') {
          this.scroll(-3);
        } else if (token.logicalName === 'down') {
          this.scroll(3);
        }
      } else if (token.type === 'mouse') {
        const headerH = 2;
        const viewportRow = token.row - headerH;

        if (token.button === 64) this.scroll(-3);
        else if (token.button === 65) this.scroll(3);

        if (token.button === 1 && token.action === 'press') {
          const text = pasteFromClipboard();
          if (text) this.prompt += text;
          this.bus.emit('render:request');
          continue;
        }

        if (token.button === 0 && token.action === 'press') {
          this.selection.startSelection(token.col, viewportRow, scrollTop, vHeight, lineCount);
        } else if (token.button === 32) {
          this.selection.extendSelection(token.col, viewportRow, scrollTop, vHeight, lineCount);
        } else if (token.action === 'release') {
          this.handleCopy();
          this.selection.endSelection();
        }
      }
    }
    this.bus.emit('render:request');
  }
}
