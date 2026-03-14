import { InputTokenizer } from '../core/tokenizer.ts';
import { SelectionManager } from './selection.ts';
import { copyToClipboard, pasteFromClipboard } from '../utils/clipboard.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { InfiniteBuffer } from '../core/history.ts';
import type { CommandRegistry, CommandContext } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';

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

  private tokenizer = new InputTokenizer();
  private pasteRegistry = new Map<string, string>();
  private nextPasteId = 1;
  private lastCtrlCTime = 0;
  private commandRegistry: CommandRegistry | null = null;
  private commandContext: CommandContext | null = null;
  public autocomplete: AutocompleteEngine | null = null;

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
   * setCommandRegistry - Wire in the slash command registry and context.
   * Must be called before commands can be processed.
   */
  public setCommandRegistry(registry: CommandRegistry, context: CommandContext): void {
    this.commandRegistry = registry;
    this.commandContext = context;
    this.autocomplete = new AutocompleteEngine(registry);
  }

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

  /**
   * Handle Ctrl+C:
   * - If prompt has text: clear it
   * - If prompt is empty and LLM is thinking: cancel generation
   * - If prompt is empty and idle: show exit notice (double = exit)
   */
  private handleCtrlC(): void {
    if (this.prompt.length > 0) {
      // Clear the input
      this.prompt = '';
      this.cursorPos = 0;
      return;
    }
    // Prompt is empty — try to cancel or exit
    this.bus.emit('cancel:generation');
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
   * Handle Escape:
   * - If prompt has text: clear it
   * - If prompt is empty: cancel generation (double-tap not needed)
   */
  private handleEscape(): void {
    if (this.prompt.length > 0) {
      this.prompt = '';
      this.cursorPos = 0;
      return;
    }
    // Prompt is empty — cancel generation
    this.bus.emit('cancel:generation');
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
        const text = this.registerPaste(token.value);
        this.prompt = this.prompt.slice(0, this.cursorPos) + text + this.prompt.slice(this.cursorPos);
        this.cursorPos += text.length;
        this.ensureInputCursorVisible();
        // Detect slash-command mode: '/' typed into empty prompt
        if (this.prompt === '/' && this.commandRegistry) {
          this.commandMode = true;
          this.autocomplete?.update('');
          this.bus.emit('command:mode-enter');
        } else if (this.commandMode && this.commandRegistry) {
          // Update autocomplete with text after '/'
          const query = this.prompt.startsWith('/') ? this.prompt.slice(1) : '';
          const spaceIdx = query.indexOf(' ');
          // Only autocomplete while still typing the command name (no space yet)
          if (spaceIdx === -1) {
            this.autocomplete?.update(query);
          }
          this.bus.emit('command:autocomplete', { query });
        }
        continue;
      } else if (token.type === 'key') {
        // --- Global shortcuts (always active) ---
        if (token.logicalName === 'c' && token.ctrl && token.shift) {
          this.handleCopy();
          continue;
        }
        if (token.logicalName === 'c' && token.ctrl && !token.shift) {
          this.handleCtrlC();
          continue;
        }
        if (token.logicalName === 'escape') {
          this.handleEscape();
          continue;
        }
        // Ctrl+L: clear screen (re-render)
        if (token.logicalName === 'l' && token.ctrl) {
          this.bus.emit('render:request');
          continue;
        }
        // Ctrl+U: clear prompt line
        if (token.logicalName === 'u' && token.ctrl) {
          this.prompt = '';
          this.cursorPos = 0;
          if (this.commandMode) {
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');
          }
          continue;
        }
        // PageUp: scroll by viewport page
        if (token.logicalName === 'pageup') {
          this.scroll(-Math.max(1, vHeight - 2));
          continue;
        }
        // PageDown: scroll by viewport page
        if (token.logicalName === 'pagedown') {
          this.scroll(Math.max(1, vHeight - 2));
          continue;
        }

        // --- Command mode routing ---
        if (this.commandMode) {
          if (token.logicalName === 'escape') {
            // Exit command mode without executing
            this.prompt = '';
            this.cursorPos = 0;
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');
            continue;
          }
          if (token.logicalName === 'up') {
            this.autocomplete?.moveUp();
            continue;
          }
          if (token.logicalName === 'down') {
            this.autocomplete?.moveDown();
            continue;
          }
          if (token.logicalName === 'tab') {
            // Tab: autocomplete to selected command
            const selected = this.autocomplete?.getSelected();
            if (selected) {
              this.prompt = `/${selected.name} `;
              this.autocomplete?.reset();
            }
            continue;
          }
          if (token.logicalName === 'backspace') {
            this.prompt = this.prompt.slice(0, -1);
            if (this.prompt === '') {
              // Erased the '/' — exit command mode
              this.commandMode = false;
              this.autocomplete?.reset();
              this.bus.emit('command:mode-exit');
            } else {
              const query = this.prompt.startsWith('/') ? this.prompt.slice(1) : '';
              const spaceIdx = query.indexOf(' ');
              if (spaceIdx === -1) this.autocomplete?.update(query);
            }
            continue;
          }
          if (token.logicalName === 'enter') {
            // Execute the command
            const raw = this.prompt.trim();
            this.prompt = '';
            this.cursorPos = 0;
            this.commandMode = false;
            this.autocomplete?.reset();
            this.bus.emit('command:mode-exit');

            if (raw.startsWith('/') && this.commandRegistry && this.commandContext) {
              const parts = raw.slice(1).trim().split(/\s+/);
              const name = parts[0];
              const args = parts.slice(1);
              void this.commandRegistry.execute(name, args, this.commandContext);
              this.bus.emit('command:execute', { name, args });
            }
            continue;
          }
          continue; // in command mode: let text tokens handle character typing
        }

        // --- Normal mode ---
        if (token.logicalName === 'enter') {
          if (token.shift) {
            this.prompt = this.prompt.slice(0, this.cursorPos) + '\n' + this.prompt.slice(this.cursorPos);
            this.cursorPos++;
            this.ensureInputCursorVisible();
          } else {
            const text = this.prompt.trim();
            if (text === ':q') {
              this.exitApp();
              return;
            }
            if (text) {
              this.prompt = '';
              this.cursorPos = 0;
              const fullText = this.expandPrompt(text);
              this.bus.emit('input:submit', { text: fullText });
            }
          }
          continue;
        }

        if (token.logicalName === 'backspace') {
          if (this.cursorPos > 0) {
            this.prompt = this.prompt.slice(0, this.cursorPos - 1) + this.prompt.slice(this.cursorPos);
            this.cursorPos--;
          }
        } else if (token.logicalName === 'delete') {
          if (this.cursorPos < this.prompt.length) {
            this.prompt = this.prompt.slice(0, this.cursorPos) + this.prompt.slice(this.cursorPos + 1);
          }
        } else if (token.logicalName === 'left') {
          if (this.cursorPos > 0) this.cursorPos--;
        } else if (token.logicalName === 'right') {
          if (this.cursorPos < this.prompt.length) this.cursorPos++;
        } else if (token.logicalName === 'home') {
          this.cursorPos = 0;
        } else if (token.logicalName === 'end') {
          this.cursorPos = this.prompt.length;
        } else if (token.logicalName === 'up') {
          // In multiline input: move cursor up within text. At top: scroll viewport.
          if (!this.moveCursorVertical(-1)) {
            this.scroll(-3);
          }
        } else if (token.logicalName === 'down') {
          if (!this.moveCursorVertical(1)) {
            this.scroll(3);
          }
        } else if (token.logicalName === 'pageup') {
          this.scroll(-this.getViewportHeight());
        } else if (token.logicalName === 'pagedown') {
          this.scroll(this.getViewportHeight());
        }
      } else if (token.type === 'mouse') {
        const headerH = 2;
        const viewportRow = token.row - headerH;

        if (token.button === 64) this.scroll(-3);
        else if (token.button === 65) this.scroll(3);

        if (token.button === 1 && token.action === 'press') {
          const raw = pasteFromClipboard();
          if (raw) {
            const text = this.registerPaste(raw);
            this.prompt = this.prompt.slice(0, this.cursorPos) + text + this.prompt.slice(this.cursorPos);
            this.cursorPos += text.length;
            this.ensureInputCursorVisible();
          }
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

  /**
   * Get the line number (0-based) the cursor is currently on.
   */
  private getCursorLine(): number {
    return this.prompt.slice(0, this.cursorPos).split('\n').length - 1;
  }

  /**
   * Move cursor up or down by one line within multiline input.
   * Returns true if the cursor moved (input had another line to go to),
   * false if at boundary (caller should scroll viewport instead).
   */
  private moveCursorVertical(direction: -1 | 1): boolean {
    const lines = this.prompt.split('\n');
    if (lines.length <= 1) return false; // Single line — can't move vertically

    const cursorLine = this.getCursorLine();
    const targetLine = cursorLine + direction;

    if (targetLine < 0 || targetLine >= lines.length) return false; // At boundary

    // Calculate column offset within current line
    let lineStart = 0;
    for (let i = 0; i < cursorLine; i++) lineStart += lines[i].length + 1;
    const col = this.cursorPos - lineStart;

    // Calculate new cursor position in target line
    let targetStart = 0;
    for (let i = 0; i < targetLine; i++) targetStart += lines[i].length + 1;
    this.cursorPos = targetStart + Math.min(col, lines[targetLine].length);

    this.ensureInputCursorVisible();
    return true;
  }

  /**
   * Ensure the cursor's wrapped line is visible within the input scroll window.
   */
  public ensureInputCursorVisible(contentWidth?: number): void {
    const info = this.getWrappedPromptInfo(contentWidth ?? 76);
    const maxRows = InputHandler.MAX_INPUT_ROWS;
    if (info.cursorWrappedLine < this.inputScrollTop) {
      this.inputScrollTop = info.cursorWrappedLine;
    } else if (info.cursorWrappedLine >= this.inputScrollTop + maxRows) {
      this.inputScrollTop = info.cursorWrappedLine - maxRows + 1;
    }
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
  public getWrappedPromptInfo(contentWidth: number): {
    wrappedLines: string[];
    cursorWrappedLine: number;
    cursorCol: number;
    visibleLines: string[];
    visibleCursorLine: number; // -1 if cursor is not in visible window
    visibleCursorCol: number;
  } {
    const rawLines = this.prompt.split('\n');
    const wrappedLines: string[] = [];
    let cursorWrappedLine = 0;
    let cursorCol = 0;
    let charsSeen = 0;

    for (let r = 0; r < rawLines.length; r++) {
      const rawLine = rawLines[r];
      // Word-wrap this raw line
      const wrapped = this.wordWrapLine(rawLine, contentWidth);

      for (let w = 0; w < wrapped.length; w++) {
        const wLine = wrapped[w];
        const lineStartInPrompt = charsSeen;
        const lineEndInPrompt = charsSeen + wLine.length;

        // Check if cursor falls in this wrapped segment
        if (this.cursorPos >= lineStartInPrompt && this.cursorPos <= lineEndInPrompt) {
          // Only assign if this is the tightest match (cursor at boundary goes to earlier line end)
          if (this.cursorPos < lineEndInPrompt || w === wrapped.length - 1) {
            cursorWrappedLine = wrappedLines.length;
            cursorCol = this.cursorPos - lineStartInPrompt;
          }
        }

        wrappedLines.push(wLine);
        charsSeen += wLine.length;

        // Account for the space consumed at each word-wrap break point.
        // wordWrapLine splits "abc def|ghi jkl" into ["abc def", "ghi jkl"]
        // The space between "def" and "ghi" is in the raw string but in
        // neither wrapped segment. Increment charsSeen to skip past it.
        if (w < wrapped.length - 1) {
          charsSeen++; // the consumed space at the break point
        }
      }

      // Account for the \n between raw lines (except after the last)
      if (r < rawLines.length - 1) {
        charsSeen++; // the \n character
      }
    }

    // Visible window
    const maxRows = InputHandler.MAX_INPUT_ROWS;
    const visibleLines = wrappedLines.slice(this.inputScrollTop, this.inputScrollTop + maxRows);
    const visibleCursorLine = cursorWrappedLine - this.inputScrollTop;
    const isVisible = visibleCursorLine >= 0 && visibleCursorLine < maxRows;

    return {
      wrappedLines,
      cursorWrappedLine,
      cursorCol,
      visibleLines,
      visibleCursorLine: isVisible ? visibleCursorLine : -1,
      visibleCursorCol: isVisible ? cursorCol : 0,
    };
  }

  /**
   * Word-wrap a single line to fit within maxW columns.
   * Breaks at spaces; words wider than maxW are force-broken.
   */
  private wordWrapLine(line: string, maxW: number): string[] {
    if (maxW <= 0) return [line];
    if (line.length === 0) return [''];

    const result: string[] = [];
    const words = line.split(' ');
    let current = '';

    for (const word of words) {
      if (current.length === 0) {
        if (word.length > maxW) {
          // Force-break long word
          let remaining = word;
          while (remaining.length > maxW) {
            result.push(remaining.slice(0, maxW));
            remaining = remaining.slice(maxW);
          }
          current = remaining;
        } else {
          current = word;
        }
      } else if (current.length + 1 + word.length <= maxW) {
        current += ' ' + word;
      } else {
        result.push(current);
        if (word.length > maxW) {
          let remaining = word;
          while (remaining.length > maxW) {
            result.push(remaining.slice(0, maxW));
            remaining = remaining.slice(maxW);
          }
          current = remaining;
        } else {
          current = word;
        }
      }
    }
    if (current.length > 0 || result.length === 0) {
      result.push(current);
    }
    return result;
  }
}
