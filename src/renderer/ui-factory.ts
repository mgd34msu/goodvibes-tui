import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';
import { LAYOUT } from './layout.ts';
import { VERSION } from '../version.ts';
import { getDisplayWidth, wrapText, interpolateColor } from '../utils/terminal-width.ts';
import type { GitHeaderInfo } from './git-status.ts';

/** Number of frames before the animated gradient completes one full cycle. */
const GRADIENT_CYCLE_FRAMES = 50;
/** Number of frames before rotating to the next thinking phrase (~30 seconds at 80ms/frame). */
const PHRASE_ROTATION_FRAMES = 375;

/** Build the git segment string and its display width. Single source of truth for header layout. */
function buildGitSegment(gitInfo: GitHeaderInfo): { text: string; width: number } {
  const branch = ` ⎇ ${gitInfo.branch}`;
  if (gitInfo.dirty) {
    const text = `${branch} ● `;
    return { text, width: getDisplayWidth(text) };
  }
  if (gitInfo.ahead > 0 || gitInfo.behind > 0) {
    const arrows = (gitInfo.ahead > 0 ? ` ↑${gitInfo.ahead}` : '') + (gitInfo.behind > 0 ? ` ↓${gitInfo.behind}` : '');
    const text = `${branch}${arrows} `;
    return { text, width: getDisplayWidth(text) };
  }
  const text = `${branch} `;
  return { text, width: getDisplayWidth(text) };
}

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
  public static createHeader(width: number, model: string, provider: string, title?: string, gitInfo?: GitHeaderInfo): Line[] {
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
      // Reserve space for git info (if present) + model/provider on the right
      const gitReserved = gitInfo ? buildGitSegment(gitInfo).width : 0;
      const rightReserved = getDisplayWidth(stats + prov) + gitReserved;
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
    // Build git info segment
    let gitStr = '';
    let gitFg = '238';
    if (gitInfo) {
      gitStr = buildGitSegment(gitInfo).text;
      if (gitInfo.dirty || gitInfo.ahead > 0 || gitInfo.behind > 0) {
        gitFg = '220'; // yellow when dirty or out-of-sync
      }
    }
    const rightSideText = stats + prov;
    const rightSideW = getDisplayWidth(rightSideText) + getDisplayWidth(gitStr);
    let rightX = width - rightSideW;
    for (const char of gitStr) { if (rightX >= 0 && rightX < width) line[rightX++] = { char, fg: gitFg, bg: '', bold: false, dim: !gitInfo?.dirty && !(gitInfo?.ahead || gitInfo?.behind), underline: false, italic: false, strikethrough: false }; }
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
    const boxMargin = LAYOUT.USER_BOX_MARGIN;
    const prefixW = getDisplayWidth(prefixStr);
    
    // 1. Calculate max available content space
    const maxAvailableContentW = width - (boxMargin * 2) - prefixW - 2;
    
    // 2. Wrap text to that space
    const wrappedLines = wrapText(text, maxAvailableContentW);
    
    // 3. Find the longest resulting line to determine the "hug" width
    const maxContentW = wrappedLines.length > 0 ? Math.max(...wrappedLines.map(l => getDisplayWidth(l))) : 0;
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
    provider?: string,
    contextWindow?: number,
    compactThreshold?: number,
    dangerMode?: boolean,
    lastInputTokens?: number,
    commandArgsHint?: string,
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

      // Overlay args hint: dim grey text after cursor on the last prompt line.
      // Only shown when a commandArgsHint is provided and cursor is at the end of input.
      if (commandArgsHint && i === promptLines.length - 1) {
        // Determine where the cursor sits on this line
        let cursorColOnLine: number;
        if (cursorPos !== undefined) {
          let lineStart = 0;
          for (let li = 0; li < i; li++) lineStart += promptLines[li].length + 1;
          cursorColOnLine = cursorPos - lineStart;
        } else {
          cursorColOnLine = text.length;
        }
        // Only show hint when cursor is at end of the last line (no args typed yet)
        if (cursorColOnLine >= text.length) {
          // Hint starts one cell after the cursor block
          const hintStartX = boxStartX + 2 + prefix.length + text.length + 1;
          const hintText = ' ' + commandArgsHint;
          let hx = hintStartX;
          for (const ch of hintText) {
            if (hx >= boxStartX + boxWidth - 2) break;
            contentLine[hx] = { char: ch, fg: '238', bg: BG_COLOR, bold: false, dim: true, underline: false, italic: false, strikethrough: false };
            hx++;
          }
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
    // Context usage progress bar
    if (contextWindow && contextWindow > 0) {
      const ctxTokens = lastInputTokens ?? 0;
      const label = '   Context Usage: ';
      const suffix = ` [ ${fmtNum(ctxTokens)} / ${fmtNum(contextWindow)} ]`;
      const barWidth = Math.max(10, Math.min(30, width - getDisplayWidth(label) - getDisplayWidth(suffix) - 8));
      const ctxPct = Math.min(1, ctxTokens / contextWindow);
      lines.push(createBaseLine());
      lines.push(this.createProgressBarLine(label, ctxPct, barWidth, width, suffix));
    }
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
      const dangerWarn = dangerMode ? `⚠ DANGER MODE — ALL CHANGES AUTO-APPROVED ` : '';
      const helpW = getDisplayWidth(help);
      const dangerW = getDisplayWidth(dangerWarn);
      const spacerW = Math.max(0, width - helpW - dangerW);
      const combinedLine = help + ' '.repeat(spacerW) + dangerWarn;
      const line = this.stringToLine(combinedLine.slice(0, width), width, { fg: '240', dim: true });
      // Overlay the danger warning in red bold
      if (dangerMode && dangerW > 0) {
        let col = helpW + spacerW;
        for (const ch of dangerWarn) {
          if (col >= width) break;
          const cw = getDisplayWidth(ch);
          line[col] = { char: ch, fg: '#ef4444', bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false };
          if (cw === 2 && col + 1 < width) line[col + 1] = { ...line[col], char: '' };
          col += cw;
        }
      }
      lines.push(line);
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

  public static createThinkingFragment(width: number, spinner: string, frame: number = 0, tokenSpeed?: number, toolPreview?: string, inputTokens?: number, outputTokens?: number): Line[] {
    // Rotate phrase every ~30 seconds (frame ticks at 80ms, so ~375 frames)
    const phraseIndex = Math.floor(frame / PHRASE_ROTATION_FRAMES) % this.THINKING_PHRASES.length;
    const phrase = this.THINKING_PHRASES[phraseIndex];
    const speedSuffix = (tokenSpeed !== undefined && tokenSpeed > 0) ? ` (${Math.round(tokenSpeed)} tok/s)` : '';
    const text = `  ${spinner} ${phrase}${speedSuffix} `;

    // Build line with animated gradient
    const line = createEmptyLine(width);
    let col = 0;
    for (const char of text) {
      if (col >= width) break;
      const code = char.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      // Animated gradient: ping-pong (triangle wave) for smooth cyan↔purple sweep
      // Use positive-safe modulo: JS % can return negative for large frame values
      const rawUnwrapped = (col / Math.max(1, getDisplayWidth(text) - 1)) - (frame % GRADIENT_CYCLE_FRAMES) * 0.02;
      const raw = ((rawUnwrapped % 1.0) + 1.0) % 1.0;
      const gradientPos = raw <= 0.5 ? raw * 2 : (1 - raw) * 2; // triangle wave: 0→1→0
      const fg = interpolateColor(this.THINK_GRADIENT_START, this.THINK_GRADIENT_END, gradientPos);
      line[col] = { char, fg, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false };
      col++;
    }

    // Append live token counter: ↑ <input> ↓ <output> (dim grey for input side, cyan for output side)
    if (inputTokens !== undefined || outputTokens !== undefined) {
      const inTok = inputTokens ?? 0;
      const outTok = outputTokens ?? 0;
      // Render input side in dim grey, output side in cyan
      const inputPart = ` \u2191 ${fmtNum(inTok)} `;
      const outputPart = `\u2193 ${fmtNum(outTok)}`;
      for (const char of inputPart) {
        if (col >= width) break;
        line[col] = { char, fg: '243', bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false };
        col++;
      }
      for (const char of outputPart) {
        if (col >= width) break;
        line[col] = { char, fg: '#00ffff', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
        col++;
      }
    }

    const lines: Line[] = [
      this.stringToLine(' '.repeat(width), width),
      line,
    ];

    if (toolPreview) {
      // Build the tool preview line with display-width-aware truncation
      const previewText = `  🔧 ${toolPreview}`;
      let truncated = '';
      let w = 0;
      for (const ch of previewText) {
        const cw = getDisplayWidth(ch);
        if (w + cw > width) break;
        truncated += ch;
        w += cw;
      }
      lines.push(this.stringToLine(truncated.padEnd(width), width, { fg: '243', dim: true }));
    }

    lines.push(this.stringToLine(' '.repeat(width), width));
    return lines;
  }

  /**
   * createProgressBarLine - Renders a labeled progress bar line.
   * @param label - Left-side label string (padded as-is)
   * @param pct - Fill fraction 0..1
   * @param barWidth - Number of bar characters
   * @param lineWidth - Total terminal width to slice to
   */
  private static createProgressBarLine(label: string, pct: number, barWidth: number, lineWidth: number, suffix?: string): Line {
    const pctDisplay = Math.round(pct * 100);
    const filled = Math.round(pct * barWidth);
    const color = pct < 0.6 ? '82' : pct < 0.85 ? '220' : '196';
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    const pctStr = `  ${pctDisplay}%`;
    const full = label + bar + pctStr + (suffix ?? '');
    return this.stringToLine(full.slice(0, lineWidth), lineWidth, { fg: color, dim: true });
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
