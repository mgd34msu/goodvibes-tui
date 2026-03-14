import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';
import { VERSION } from '../version.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';

/**
 * UIFactory - Generates standard UI fragments without needing Ink/React overhead.
 */
export class UIFactory {
  public static createHeader(width: number, model: string, provider: string): Line[] {
    const lines: Line[] = [];
    const CYAN = '#00ffff';
    const GREY = '244';
    const brand = ` GoodVibes `;
    const ver = `v${VERSION} `;
    const stats = ` ${model} `;
    const prov = `(${provider}) `;
    const line = createEmptyLine(width);
    let curX = 0;
    for (const char of brand) { line[curX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
    for (const char of ver) { line[curX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    const rightSideText = stats + prov;
    const rightSideW = getDisplayWidth(rightSideText);
    let rightX = width - rightSideW;
    for (const char of stats) { if (rightX < width) line[rightX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
    for (const char of prov) { if (rightX < width) line[rightX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    lines.push(line);
    lines.push(this.stringToLine('━'.repeat(width), width, { fg: '244' }));
    return lines;
  }

  /**
   * createMessageBar - Renders a historical user message.
   * Logic: Calculates the longest line to create a "hugging" block.
   */
  public static createMessageBar(width: number, text: string): Line[] {
    return this.createGenericBar(width, text, '#2a2a2a', '252', ' › ');
  }

  /**
   * createQueuedMessageFragment - Renders a dimmed message bar for queued prompts.
   */
  public static createQueuedMessageFragment(width: number, text: string): Line[] {
    return this.createGenericBar(width, text, '#1a1a1a', '240', ' (...) ');
  }

  /**
   * createGenericBar - Shared logic for "Ghost Box" style bars.
   * Correctly handles multi-line hugging by finding the max line width.
   */
  private static createGenericBar(width: number, text: string, bgColor: string, textColor: string, prefixStr: string): Line[] {
    const lines: Line[] = [];
    const boxMargin = 2;
    const prefixW = getDisplayWidth(prefixStr);
    
    // 1. Calculate max available content space
    const maxAvailableContentW = width - (boxMargin * 2) - prefixW - 2;
    
    // 2. Wrap text to that space
    const wrappedLines = wrapText(text, maxAvailableContentW);
    
    // 3. Find the longest resulting line to determine the "hug" width
    const maxContentW = Math.max(...wrappedLines.map(l => getDisplayWidth(l)));
    const internalWidth = maxContentW + prefixW + 2;
    const boxStartX = boxMargin;

    const createBaseLine = () => {
      const l = createEmptyLine(width);
      for (let x = 0; x < width; x++) l[x].bg = ''; 
      return l;
    };

    // 1. Top
    const topLine = createBaseLine();
    for (let x = 0; x < internalWidth; x++) {
      topLine[boxStartX + x] = { char: '▄', fg: bgColor, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    }
    lines.push(topLine);

    // 2. Content lines
    wrappedLines.forEach((lineText, i) => {
      const prefix = i === 0 ? prefixStr : ' '.repeat(prefixW);
      const contentLine = createBaseLine();
      for (let x = 0; x < internalWidth; x++) {
        const char = (x >= prefixW && x < internalWidth - 1) ? lineText[x - prefixW] || ' ' : (x < prefixW ? prefix[x] : ' ');
        contentLine[boxStartX + x] = {
          char,
          fg: (x < prefixW && i === 0) ? '135' : textColor,
          bg: bgColor,
          bold: false,
          dim: false,
          underline: false,
          italic: false,
          strikethrough: false
        };
      }
      lines.push(contentLine);
    });

    // 3. Bottom
    const bottomLine = createBaseLine();
    for (let x = 0; x < internalWidth; x++) {
      bottomLine[boxStartX + x] = { char: '▀', fg: bgColor, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    }
    lines.push(bottomLine);

    return lines;
  }

  public static createFooter(
    width: number,
    prompt: string,
    usage: { up: number; down: number; max?: number },
    showExitNotice: boolean,
    lastCopyTime: number,
    model?: string,
    toolCount?: number,
    cursorPos?: number
  ): Line[] {
    const lines: Line[] = [];
    const promptLines = prompt.split('\n');
    const TEXT_COLOR = '252'; const BG_COLOR = '#2a2a2a'; 
    const boxMargin = 2; const boxWidth = width - (boxMargin * 2); const boxStartX = boxMargin;
    const createBaseLine = () => {
      const l = createEmptyLine(width);
      for (let x = 0; x < width; x++) l[x].bg = ''; 
      return l;
    };
    const topLine = createBaseLine();
    for (let x = 0; x < boxWidth; x++) topLine[boxStartX + x] = { char: '▄', fg: BG_COLOR, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    lines.push(topLine);
    promptLines.forEach((text, i) => {
      const contentW = boxWidth - 4;
      const prefix = i === 0 ? ' › ' : '   ';
      // Insert cursor block at cursorPos within the prompt text
      let displayText = text;
      if (cursorPos !== undefined && i === promptLines.length - 1) {
        // Calculate cursor offset within this line
        let lineStart = 0;
        for (let li = 0; li < i; li++) lineStart += promptLines[li].length + 1; // +1 for \n
        const posInLine = cursorPos - lineStart;
        if (posInLine >= 0 && posInLine <= text.length) {
          displayText = text.slice(0, posInLine) + '\u2588' + text.slice(posInLine);
        } else {
          displayText = text + '\u2588';
        }
      } else if (i === promptLines.length - 1) {
        displayText = text + '\u2588';
      }
      const rawText = `${prefix}${displayText}`;
      const paddedText = rawText.padEnd(contentW);
      const contentLine = createBaseLine();
      for (let x = 0; x < boxWidth; x++) {
        const char = (x >= 2 && x < boxWidth - 2) ? paddedText[x - 2] || ' ' : ' ';
        contentLine[boxStartX + x] = { char, fg: (x < 5 && i === 0) ? '135' : TEXT_COLOR, bg: BG_COLOR, bold: false, dim: false, underline: false, italic: false, strikethrough: false };
      }
      lines.push(contentLine);
    });
    const bottomLine = createBaseLine();
    for (let x = 0; x < boxWidth; x++) bottomLine[boxStartX + x] = { char: '▀', fg: BG_COLOR, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    lines.push(bottomLine);
    lines.push(createBaseLine());
    const isRecentlyCopied = Date.now() - lastCopyTime < 2000;
    const total = usage.up + usage.down;
    const pct = usage.max ? Math.min(100, Math.round((total / usage.max) * 100)) : null;
    const modelStr = model ? `  ${model}` : '';
    const toolStr = toolCount ? `  tools:${toolCount}` : '';
    const pctStr = pct !== null ? `  ctx:${pct}%` : '';
    const stats = ` Tokens: ${total}${modelStr}${toolStr}${pctStr} `;
    const copiedNotice = isRecentlyCopied ? ` [COPIED TO CLIPBOARD] ` : '';
    const statsLine = '  ' + stats + ' '.repeat(Math.max(0, width - 4 - getDisplayWidth(stats) - getDisplayWidth(copiedNotice))) + copiedNotice;
    lines.push(this.stringToLine(statsLine, width, { fg: isRecentlyCopied ? '81' : '244', bold: isRecentlyCopied }));
    lines.push(createBaseLine());
    if (showExitNotice) {
      const notice = `   !!! Press Ctrl+C again to exit !!! `;
      lines.push(this.stringToLine(notice.padEnd(width), width, { fg: '196', bold: true }));
    } else {
      const help = `   Enter=send  Shift+Enter=newline  Ctrl+C=quit `;
      lines.push(this.stringToLine(help.padEnd(width), width, { fg: '240', dim: true }));
    }
    lines.push(createBaseLine());
    return lines;
  }

  public static createThinkingFragment(width: number, spinner: string): Line[] {
    const label = ` ${spinner} Thinking... `;
    return [
      this.stringToLine(label.padEnd(width), width, { fg: '135', bold: true }),
      this.stringToLine(' '.repeat(width), width)
    ];
  }

  public static stringToLine(text: string, width: number, style: Partial<Cell> = {}): Line {
    const line = createEmptyLine(width);
    let currentColumn = 0;
    for (const char of text) {
      if (currentColumn >= width) break;
      const code = char.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      const charWidth = getDisplayWidth(char);
      line[currentColumn] = {
        char,
        fg: style.fg || '',
        bg: style.bg || '',
        bold: style.bold || false,
        dim: style.dim || false,
        underline: style.underline || false,
        italic: style.italic || false,
        strikethrough: style.strikethrough || false
      };
      if (charWidth === 2 && currentColumn + 1 < width) {
        line[currentColumn + 1] = { ...line[currentColumn], char: '' };
      }
      currentColumn += charWidth;
    }
    return line;
  }
}
