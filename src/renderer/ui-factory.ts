import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';
import { VERSION } from '../version.ts';
import { getDisplayWidth, wrapText, interpolateColor } from '../utils/terminal-width.ts';

/** Format a number: up to 999, then 1.0k, 1.0M, 1.0B, 1.0T */
function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n < 1_000_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  return (n / 1_000_000_000_000).toFixed(1) + 'T';
}

/**
 * UIFactory - Generates standard UI fragments without needing Ink/React overhead.
 */
export class UIFactory {
  public static createHeader(width: number, model: string, provider: string, title?: string): Line[] {
    const lines: Line[] = [];
    const CYAN = '#00ffff';
    const GREY = '244';
    const TITLE_COLOR = '250';
    const brand = ` GoodVibes `;
    const ver = `v${VERSION} `;
    const stats = ` ${model} `;
    const prov = `(${provider}) `;
    const line = createEmptyLine(width);
    let curX = 0;
    for (const char of brand) { line[curX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
    for (const char of ver) { line[curX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    // Optional conversation title — shown after brand/ver, truncated to fit
    if (title) {
      const titleStr = `| ${title} `;
      const rightReserved = getDisplayWidth(stats + prov);
      const maxTitleW = width - curX - rightReserved - 1;
      let displayTitle: string;
      if (getDisplayWidth(titleStr) <= maxTitleW) {
        displayTitle = titleStr;
      } else {
        let truncated = '';
        let w = 0;
        for (const ch of titleStr) {
          const cw = getDisplayWidth(ch);
          if (w + cw > maxTitleW - 1) { truncated += '…'; break; }
          truncated += ch;
          w += cw;
        }
        displayTitle = truncated;
      }
      for (const char of displayTitle) { if (curX < width) line[curX++] = { char, fg: TITLE_COLOR, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    }
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
  public static createMessageBar(
    width: number, text: string,
    bgColor = '#2a2a2a', textColor = '252', prefixStr = ' › ',
    strikethrough = false
  ): Line[] {
    return this.createGenericBar(width, text, bgColor, textColor, prefixStr, strikethrough);
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
  private static createGenericBar(width: number, text: string, bgColor: string, textColor: string, prefixStr: string, strikethrough = false): Line[] {
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
          strikethrough: strikethrough && x >= prefixW
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
    cursorPos?: number,
    workingDir?: string,
    provider?: string
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
      // Render text without cursor insertion — cursor is overlaid after
      const rawText = `${prefix}${text}`;
      const paddedText = rawText.padEnd(contentW);
      const contentLine = createBaseLine();
      for (let x = 0; x < boxWidth; x++) {
        const char = (x >= 2 && x < boxWidth - 2) ? paddedText[x - 2] || ' ' : ' ';
        contentLine[boxStartX + x] = { char, fg: (x < 5 && i === 0) ? '135' : TEXT_COLOR, bg: BG_COLOR, bold: false, dim: false, underline: false, italic: false, strikethrough: false };
      }

      // Overlay cursor: find if cursorPos falls on this line, invert that cell
      if (cursorPos !== undefined) {
        let lineStart = 0;
        for (let li = 0; li < i; li++) lineStart += promptLines[li].length + 1;
        const posInLine = cursorPos - lineStart;
        if (posInLine >= 0 && posInLine <= text.length) {
          // Cursor column in cell coordinates: prefix width (3) + posInLine + box padding (2)
          const cursorX = boxStartX + 2 + prefix.length + posInLine;
          if (cursorX < boxStartX + boxWidth - 2) {
            const cell = contentLine[cursorX];
            // Invert: bright fg on the text bg, swap to make cursor visible
            contentLine[cursorX] = {
              char: cell.char === ' ' ? '\u2588' : cell.char,
              fg: cell.char === ' ' ? '252' : '#000000',
              bg: cell.char === ' ' ? BG_COLOR : '#ffffff',
              bold: false, dim: false, underline: false, italic: false, strikethrough: false
            };
          }
        }
      } else if (i === promptLines.length - 1) {
        // No cursorPos provided — show block at end (fallback)
        const endX = boxStartX + 2 + prefix.length + text.length;
        if (endX < boxStartX + boxWidth - 2) {
          contentLine[endX] = { char: '\u2588', fg: '252', bg: BG_COLOR, bold: false, dim: false, underline: false, italic: false, strikethrough: false };
        }
      }

      lines.push(contentLine);
    });
    const bottomLine = createBaseLine();
    for (let x = 0; x < boxWidth; x++) bottomLine[boxStartX + x] = { char: '▀', fg: BG_COLOR, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    lines.push(bottomLine);
    lines.push(createBaseLine());
    const isRecentlyCopied = Date.now() - lastCopyTime < 2000;
    // Token usage line
    const u = usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; up?: number; down?: number };
    const inp = u.input ?? u.up ?? 0;
    const out = u.output ?? u.down ?? 0;
    const cr = u.cacheRead ?? 0;
    const cw = u.cacheWrite ?? 0;
    const total = inp + out + cr + cw;
    const tokenLine = ` Token Usage [ Input: ${fmtNum(inp)} | Output: ${fmtNum(out)} | Cache Read: ${fmtNum(cr)} | Cache Write: ${fmtNum(cw)} | Total: ${fmtNum(total)} ]`;
    const copiedNotice = isRecentlyCopied ? ` [COPIED] ` : '';
    const statsLine = '  ' + tokenLine + ' '.repeat(Math.max(0, width - 4 - getDisplayWidth(tokenLine) - getDisplayWidth(copiedNotice))) + copiedNotice;
    lines.push(this.stringToLine(statsLine, width, { fg: isRecentlyCopied ? '81' : '244', bold: isRecentlyCopied }));
    // Context info line (working dir, model+provider, tools)
    if (workingDir || model) {
      const home = typeof process !== 'undefined' ? process.env.HOME ?? '' : '';
      const displayDir = workingDir && home && workingDir.startsWith(home)
        ? '~' + workingDir.slice(home.length)
        : workingDir ?? '';
      const ctxParts: string[] = [];
      if (displayDir) ctxParts.push(displayDir);
      if (model) {
        ctxParts.push(model + (provider ? ` (${provider})` : ''));
      }
      if (toolCount) ctxParts.push(`${toolCount} tools`);
      const ctxLine = '   ' + ctxParts.join('  \u00B7  ');
      lines.push(createBaseLine());
      lines.push(this.stringToLine(ctxLine.slice(0, width), width, { fg: '240', dim: true }));
      lines.push(createBaseLine());
    }
    if (showExitNotice) {
      const notice = `   !!! Press Ctrl+C again to exit !!! `;
      lines.push(this.stringToLine(notice.padEnd(width), width, { fg: '196', bold: true }));
    } else {
      const help = `   /help for commands  -  Ctrl+C to quit `;
      lines.push(this.stringToLine(help.padEnd(width), width, { fg: '240', dim: true }));
    }
    lines.push(createBaseLine());
    return lines;
  }

  /** Rotating thinking phrases — vaporwave / good vibes themed. */
  private static readonly THINKING_PHRASES = [
    'Thinking...',
    'Vibing...',
    'Manifesting...',
    'Channeling energy...',
    'Tuning frequencies...',
    'Riding the wave...',
    'Aligning chakras...',
    'Entering flow state...',
    'Consulting the void...',
    'Absorbing aesthetics...',
    'Synthesizing vibes...',
    'Transcending...',
    'Dreaming in neon...',
    'Parsing the cosmos...',
    'Loading good vibes...',
    'Meditating...',
    'Catching a vibe...',
    'Harmonizing...',
    'Feeling it...',
    'In the zone...',
  ];

  /** Gradient colors for thinking text — cyan to purple (matches splash). */
  private static readonly THINK_GRADIENT_START = '#00ffff';
  private static readonly THINK_GRADIENT_END = '#d000ff';

  public static createThinkingFragment(width: number, spinner: string, frame: number = 0): Line[] {
    // Rotate phrase every ~3 seconds (frame ticks at 80ms, so ~37 frames)
    const phraseIndex = Math.floor(frame / 37) % this.THINKING_PHRASES.length;
    const phrase = this.THINKING_PHRASES[phraseIndex];
    const text = `  ${spinner} ${phrase} `;

    // Build line with animated gradient
    const line = createEmptyLine(width);
    let col = 0;
    for (const char of text) {
      if (col >= width) break;
      const code = char.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      // Animated gradient: ping-pong (triangle wave) for smooth cyan↔purple sweep
      const raw = (col / Math.max(1, getDisplayWidth(text) - 1) - frame * 0.02 + 100) % 1.0;
      const gradientPos = raw <= 0.5 ? raw * 2 : (1 - raw) * 2; // triangle wave: 0→1→0
      const fg = interpolateColor(this.THINK_GRADIENT_START, this.THINK_GRADIENT_END, gradientPos);
      line[col] = { char, fg, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false };
      col++;
    }

    return [
      this.stringToLine(' '.repeat(width), width),
      line,
      this.stringToLine(' '.repeat(width), width),
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
