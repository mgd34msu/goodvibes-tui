import { InfiniteBuffer } from './history.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { InceptionProvider } from './inception.ts';
import { createEmptyLine } from '../types/grid.ts';
import { getSplashLines } from '../utils/splash-lines.ts';
import { type Line } from '../types/grid.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface SelectionPoint {
  col: number;
  row: number;
}

interface CachedMessage {
  role: string;
  content: string;
  lines: Line[];
}

/**
 * StateManager - Global Singleton for TUI State and AI logic.
 */
export class StateManager {
  public history = new InfiniteBuffer();
  public prompt = '';
  public scrollTop = 0;
  public model = 'mercury-2';
  public provider = 'inceptionlabs';
  public usage = { up: 0, down: 0 };
  
  public isThinking = false;
  public thinkingFrame = 0;
  public showExitNotice = false;
  public lastCopyTime = 0;

  public messageQueue: string[] = [];

  // --- Paste Marker Registry ---
  private pasteRegistry = new Map<string, string>();
  private nextPasteId = 1;

  public selectionAnchor: SelectionPoint | null = null;
  public selectionFocus: SelectionPoint | null = null;
  public isDragging = false;

  private messages: { role: string; content: string }[] = [];
  private llm: InceptionProvider;
  private animInterval: any = null;

  constructor() {
    this.llm = new InceptionProvider(process.env.INCEPTION_API_KEY || '');
  }

  public getSpinner(): string {
    return SPINNER_FRAMES[this.thinkingFrame % SPINNER_FRAMES.length];
  }

  /**
   * registerPaste - Stores multi-line content and returns a visual marker string.
   */
  public registerPaste(content: string): string {
    const lines = content.split('\n');
    // Audit Fix: Only mark if > 8 lines
    if (lines.length <= 8) return content;

    const id = `p${this.nextPasteId++}`;
    this.pasteRegistry.set(id, content);
    return `[PASTE:${id} (${lines.length} lines)]`;
  }

  /**
   * expandPrompt - Replaces markers with actual content and cleans up registry.
   */
  private expandPrompt(text: string): string {
    let expanded = text;
    const foundIds = new Set<string>();
    const markerRegex = /\[PASTE:(p\d+) \(\d+ lines\)\]/g;
    let match;

    while ((match = markerRegex.exec(expanded)) !== null) {
      const id = match[1];
      const content = this.pasteRegistry.get(id);
      if (content) {
        expanded = expanded.replace(match[0], content);
        foundIds.add(id);
      }
    }

    // Cleanup: Remove any registry entries that are no longer in the prompt
    for (const id of this.pasteRegistry.keys()) {
      if (!foundIds.has(id)) {
        this.pasteRegistry.delete(id);
      }
    }

    return expanded;
  }

  public pullFromQueue(): boolean {
    if (this.messageQueue.length === 0) return false;
    const lastMsg = this.messageQueue.pop();
    if (lastMsg !== undefined) {
      this.prompt = lastMsg;
      return true;
    }
    return false;
  }

  public async sendMessage(text: string, onUpdate: () => void) {
    if (!text.trim()) return;

    // Expand markers before queuing or processing
    const fullText = this.expandPrompt(text);

    if (this.isThinking) {
      this.messageQueue.push(fullText);
      onUpdate();
      return;
    }

    this.messages.push({ role: 'user', content: fullText });
    this.refreshHistory();
    this.scrollToEnd(this.getViewportHeight());
    
    this.isThinking = true;
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = setInterval(() => { this.thinkingFrame++; onUpdate(); }, 80);
    onUpdate();

    try {
      const response = await this.llm.sendMessage({
        messages: this.messages.map(m => ({ role: m.role, content: m.content })),
        onText: () => {}
      });
      this.messages.push({ role: 'assistant', content: response.content });
      this.usage.up += response.usage.inputTokens;
      this.usage.down += response.usage.outputTokens;
      this.refreshHistory();
    } catch (error: any) {
      this.messages.push({ role: 'system', content: `Error: ${error.message}` });
      this.refreshHistory();
    } finally {
      if (this.animInterval) clearInterval(this.animInterval);
      this.isThinking = false;
      this.scrollToEnd(this.getViewportHeight());
      onUpdate();
      if (this.messageQueue.length > 0) {
        const nextMsg = this.messageQueue.shift();
        if (nextMsg) this.sendMessage(nextMsg, onUpdate);
      }
    }
  }

  public refreshHistory() {
    this.history.clear();
    const width = process.stdout.columns || 80;

    if (this.messages.length === 0) {
      const splashStrings = getSplashLines(width);
      const CYAN = '#00ffff'; const PURPLE = '#d000ff'; const GREY = '244';
      splashStrings.forEach((str, y) => {
        const line = UIFactory.stringToLine(str, width);
        const isVersion = y === splashStrings.length - 1;
        const startX = Math.floor((width - getDisplayWidth(str)) / 2);
        const endX = startX + getDisplayWidth(str);
        for (let x = 0; x < width; x++) {
          const cell = line[x];
          if (cell.char === ' ' && (x < startX || x >= endX)) continue;
          if (isVersion) { cell.fg = GREY; cell.dim = true; } 
          else {
            const factor = (x - startX) / (endX - startX || 1);
            cell.fg = interpolateColor(CYAN, PURPLE, Math.max(0, Math.min(1, factor)));
            cell.bold = true;
          }
        }
        this.history.addLine(line);
      });
      this.history.addLine(createEmptyLine(width));
      this.history.addLine(createEmptyLine(width));
      return;
    }
    
    this.messages.forEach(m => {
      if (m.role === 'user') {
        this.history.addLines(UIFactory.createMessageBar(width, m.content));
      } else {
        const color = m.role === 'system' ? '196' : '15';
        const lines = this.textToLines(m.content, { fg: color });
        this.history.addLines(lines);
      }
      this.history.addLine(createEmptyLine(width));
      this.history.addLine(createEmptyLine(width));
    });
  }

  private textToLines(text: string, style: any = {}): Line[] {
    const width = process.stdout.columns || 80;
    const tabWidth = 4;
    const contentWidth = width - tabWidth - 2; 
    const wrapped = wrapText(text, contentWidth);
    
    return wrapped.map((l, i) => {
      const prefix = i === 0 ? '>   ' : '    ';
      return UIFactory.stringToLine(prefix + l, width, style);
    });
  }

  public getViewportHeight(): number {
    const promptLines = this.prompt.split('\n').length;
    return (process.stdout.rows || 24) - 2 - (7 + promptLines);
  }

  private screenToAbsoluteRow(row: number): number {
    const vHeight = this.getViewportHeight();
    const lineCount = this.history.getLineCount();
    const offset = Math.max(0, vHeight - lineCount);
    return this.scrollTop + (row - offset);
  }

  public startSelection(col: number, viewportRow: number) {
    const absoluteRow = this.screenToAbsoluteRow(viewportRow);
    this.selectionAnchor = { col, row: absoluteRow };
    this.selectionFocus = { col, row: absoluteRow };
    this.isDragging = true;
  }

  public extendSelection(col: number, viewportRow: number) {
    if (!this.isDragging) return;
    const absoluteRow = this.screenToAbsoluteRow(viewportRow);
    this.selectionFocus = { col, row: absoluteRow };
  }

  public endSelection() { this.isDragging = false; }
  public clearSelection() { this.selectionAnchor = null; this.selectionFocus = null; this.isDragging = false; }

  public hasSelection(): boolean {
    if (!this.selectionAnchor || !this.selectionFocus) return false;
    return this.selectionAnchor.row !== this.selectionFocus.row || 
           this.selectionAnchor.col !== this.selectionFocus.col;
  }

  public getSelectedText(): string {
    if (!this.selectionAnchor || !this.selectionFocus) return '';
    const start = this.selectionAnchor.row < this.selectionFocus.row || (this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col <= this.selectionFocus.col) ? this.selectionAnchor : this.selectionFocus;
    const end = start === this.selectionAnchor ? this.selectionFocus : this.selectionAnchor;
    
    const lines: string[] = [];
    const allLines = this.history.getAllLines();

    for (let r = Math.max(0, start.row); r <= Math.min(allLines.length - 1, end.row); r++) {
      const line = allLines[r];
      if (!line) continue;

      const startCol = (r === start.row) ? start.col : 0;
      const endCol = (r === end.row) ? end.col : line.length;
      
      let lineText = '';
      for (let c = Math.max(0, startCol); c < Math.min(line.length, endCol); c++) {
        const cell = line[c];
        if (cell && cell.char !== '') lineText += cell.char;
      }
      
      const trimmed = lineText.trim();
      if (trimmed || r === start.row || r === end.row) {
        lines.push(trimmed);
      }
    }
    
    return lines.join('\n');
  }

  public isCellSelected(col: number, absoluteRow: number): boolean {
    if (!this.selectionAnchor || !this.selectionFocus) return false;
    const start = this.selectionAnchor.row < this.selectionFocus.row || (this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col <= this.selectionFocus.col) ? this.selectionAnchor : this.selectionFocus;
    const end = start === this.selectionAnchor ? this.selectionFocus : this.selectionAnchor;
    if (absoluteRow < start.row || absoluteRow > end.row) return false;
    if (absoluteRow === start.row && absoluteRow === end.row) return col >= start.col && col < end.col;
    if (absoluteRow === start.row) return col >= start.col;
    if (absoluteRow === end.row) return col < end.col;
    return true;
  }

  public scroll(delta: number, viewportHeight: number) {
    const maxScroll = Math.max(0, this.history.getLineCount() - viewportHeight);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, maxScroll));
  }

  public scrollToEnd(viewportHeight: number) {
    this.scrollTop = Math.max(0, this.history.getLineCount() - viewportHeight);
  }

  public log(text: string, style: any = {}, indent = '  ') {
    const width = process.stdout.columns || 80;
    const lines = text.split('\n').map((l, i) => UIFactory.stringToLine((i === 0 ? l : indent + l), width, style));
    this.history.addLines(lines);
  }
}

export const state = new StateManager();
