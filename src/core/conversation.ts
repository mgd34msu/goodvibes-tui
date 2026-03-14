import { InfiniteBuffer } from './history.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { createEmptyLine } from '../types/grid.ts';
import { getSplashLines } from '../utils/splash-lines.ts';
import { type Line, type Cell } from '../types/grid.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';

/**
 * ConversationManager - Owns conversation messages and the rendered history buffer.
 * Extracted from StateManager.
 */
export class ConversationManager {
  public history = new InfiniteBuffer();
  private messages: { role: string; content: string }[] = [];

  public getMessagesForLLM(): { role: string; content: string }[] {
    return this.messages.map(m => ({ role: m.role, content: m.content }));
  }

  public addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
    this.rebuildHistory();
  }

  public addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
    this.rebuildHistory();
  }

  public addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
    this.rebuildHistory();
  }

  public getDisplayBlocks(): Line[] {
    return this.history.getAllLines();
  }

  /**
   * rebuildHistory - Clears and reconstructs the InfiniteBuffer from current messages.
   * Called after every message mutation.
   */
  public rebuildHistory(): void {
    this.history.clear();
    const width = process.stdout.columns || 80;

    if (this.messages.length === 0) {
      this.addSplashScreen(width);
      return;
    }

    this.messages.forEach(m => {
      if (m.role === 'user') {
        this.history.addLines(UIFactory.createMessageBar(width, m.content));
      } else {
        const color = m.role === 'system' ? '196' : '15';
        const lines = this.textToLines(m.content, width, { fg: color });
        this.history.addLines(lines);
      }
      this.history.addLine(createEmptyLine(width));
      this.history.addLine(createEmptyLine(width));
    });
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
    const width = process.stdout.columns || 80;
    const lines = text.split('\n').map((l, i) =>
      UIFactory.stringToLine((i === 0 ? l : indent + l), width, style)
    );
    this.history.addLines(lines);
  }
}
