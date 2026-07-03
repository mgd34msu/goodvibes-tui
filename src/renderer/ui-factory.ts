import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';
import { LAYOUT } from './layout.ts';
import { VERSION } from '../version.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay, wrapText, interpolateColor } from '../utils/terminal-width.ts';
import type { GitHeaderInfo } from './git-status.ts';
import { renderConversationFragment, renderConversationStatusLine, type ConversationStatusSegment } from './conversation-surface.ts';
import { GLYPHS, UI_TONES } from './ui-primitives.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { computeContextUsage } from '../core/context-usage.ts';
import { calcSessionCost } from '../export/cost-utils.ts';
import { buildFooterTip, isAgentActive } from './footer-tips.ts';

/** Number of frames before the animated gradient completes one full cycle. */
const GRADIENT_CYCLE_FRAMES = 50;
/** Number of frames before rotating to the next thinking phrase (~30 seconds at 80ms/frame). */
const PHRASE_ROTATION_FRAMES = 375;

/** Build the git segment string and its display width. Single source of truth for header layout. */
function buildGitSegment(gitInfo: GitHeaderInfo): { text: string; width: number } {
  const branch = ` git:${gitInfo.branch}`;
  if (gitInfo.dirty) {
    const text = `${branch} * `;
    return { text, width: getDisplayWidth(text) };
  }
  if (gitInfo.ahead > 0 || gitInfo.behind > 0) {
    const arrows = (gitInfo.ahead > 0 ? ` +${gitInfo.ahead}` : '') + (gitInfo.behind > 0 ? ` -${gitInfo.behind}` : '');
    const text = `${branch}${arrows} `;
    return { text, width: getDisplayWidth(text) };
  }
  const text = `${branch} `;
  return { text, width: getDisplayWidth(text) };
}

/** Format a number: up to 999, then 1.0k, 1.0M, 1.0B, 1.0T */
function fmtNum(n: number): string {
  return abbreviateCount(n, { bSuffix: true });
}

/** Format a running USD cost estimate with a precision that suits its magnitude. */
function fmtCost(usd: number): string {
  if (!(usd > 0)) return '0.00';
  if (usd < 0.01) return usd.toFixed(4);
  if (usd < 1) return usd.toFixed(3);
  return usd.toFixed(2);
}

/**
 * UIFactory - Generates standard UI fragments without needing Ink/React overhead.
 */
export class UIFactory {
  public static createHeader(width: number, model: string, provider: string, title?: string, gitInfo?: GitHeaderInfo): Line[] {
    const lines: Line[] = [];
    const CYAN = UI_TONES.accent.brand;
    const GREY = UI_TONES.fg.dim;
    const TITLE_COLOR = UI_TONES.fg.muted;
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
      const titleStr = `│ ${title} `;
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
          if (w + cw > maxTitleW - 3) { truncated += '...'; break; }
          truncated += ch;
          w += cw;
        }
        displayTitle = truncated;
      }
      for (const char of displayTitle) { if (curX < width) line[curX++] = { char, fg: TITLE_COLOR, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    }
    // Build git info segment
    let gitStr = '';
    let gitFg: string = UI_TONES.fg.dim;
    if (gitInfo) {
      gitStr = buildGitSegment(gitInfo).text;
      if (gitInfo.dirty || gitInfo.ahead > 0 || gitInfo.behind > 0) {
        gitFg = UI_TONES.state.warn; // yellow when dirty or out-of-sync
      }
    }
    const rightSideText = stats + prov;
    const rightSideW = getDisplayWidth(rightSideText) + getDisplayWidth(gitStr);
    let rightX = width - rightSideW;
    for (const char of gitStr) { if (rightX >= 0 && rightX < width) line[rightX++] = { char, fg: gitFg, bg: '', bold: false, dim: !gitInfo?.dirty && !(gitInfo?.ahead || gitInfo?.behind), underline: false, italic: false, strikethrough: false }; }
    for (const char of stats) { if (rightX < width) line[rightX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
    for (const char of prov) { if (rightX < width) line[rightX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    lines.push(line);
    lines.push(this.stringToLine('━'.repeat(width), width, { fg: UI_TONES.fg.dim }));
    return lines;
  }

  /**
   * createMessageBar - Renders a historical user message.
   * Logic: Calculates the longest line to create a "hugging" block.
   */
  public static createMessageBar(
    width: number, text: string,
    bgColor: string = '#2a2a2a', textColor: string = UI_TONES.fg.secondary, prefixStr: string = ' › ',
    strikethrough = false
  ): Line[] {
    return renderConversationFragment(text, width, {
      prefix: prefixStr,
      prefixFg: UI_TONES.state.reasoning,
      text: textColor,
      bodyBg: bgColor,
      strikethrough,
    });
  }

  /**
   * createQueuedMessageFragment - Renders a dimmed message bar for queued prompts.
   */
  public static createQueuedMessageFragment(width: number, text: string): Line[] {
    return renderConversationFragment(text, width, {
      prefix: ' (...) ',
      prefixFg: UI_TONES.state.reasoning,
      text: UI_TONES.fg.dim,
      bodyBg: '#1a1a1a',
      dim: true,
    });
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
    hitlMode?: string,
    promptFocused: boolean = true,
    composerMode?: string,
    composerStatus?: string,
    composerFlags?: readonly string[],
    composerPendingRisk?: 'none' | 'approval-wait' | 'shell' | 'command' | 'remote',
    compact: boolean = false,
  ): Line[] {
    const lines: Line[] = [];
    const promptLines = prompt.split('\n');
    const TEXT_COLOR = promptFocused ? '252' : '246';
    const BG_COLOR = promptFocused ? '#2a2a2a' : '#1f2430';
    const BORDER_COLOR = BG_COLOR;
    const boxMargin = 2; const boxWidth = width - (boxMargin * 2); const boxStartX = boxMargin;
    const createBaseLine = () => {
      const l = createEmptyLine(width);
      for (let x = 0; x < width; x++) l[x].bg = ''; 
      return l;
    };
    const topLine = createBaseLine();
    for (let x = 0; x < boxWidth; x++) topLine[boxStartX + x] = { char: GLYPHS.surface.top, fg: BORDER_COLOR, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    lines.push(topLine);
    promptLines.forEach((text, i) => {
      const contentW = boxWidth - 4;
      const prefix = i === 0 ? ' › ' : '   ';
      // Render text without cursor insertion — cursor is overlaid after
      const rawText = `${prefix}${text}`;
      const paddedText = fitDisplay(rawText, contentW);
      const contentLine = createBaseLine();
      for (let x = 0; x < boxWidth; x++) {
        const char = (x >= 2 && x < boxWidth - 2) ? paddedText[x - 2] || ' ' : ' ';
        contentLine[boxStartX + x] = {
          char,
          fg: (x < 5 && i === 0) ? (promptFocused ? '135' : '244') : TEXT_COLOR,
          bg: BG_COLOR,
          bold: false,
          dim: !promptFocused,
          underline: false,
          italic: false,
          strikethrough: false,
        };
      }

      // Overlay cursor only while the prompt owns focus.
      if (promptFocused && cursorPos !== undefined) {
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
              char: cell.char === ' ' ? GLYPHS.surface.cursor : cell.char,
              fg: cell.char === ' ' ? '252' : '#000000',
              bg: cell.char === ' ' ? (promptFocused ? BG_COLOR : '#334155') : '#ffffff',
              bold: false, dim: false, underline: false, italic: false, strikethrough: false
            };
          }
        }
      } else if (promptFocused && i === promptLines.length - 1) {
        // No cursorPos provided — show block at end (fallback)
        const endX = boxStartX + 2 + prefix.length + text.length;
        if (endX < boxStartX + boxWidth - 2) {
          contentLine[endX] = { char: GLYPHS.surface.cursor, fg: '252', bg: promptFocused ? BG_COLOR : '#334155', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
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
    for (let x = 0; x < boxWidth; x++) bottomLine[boxStartX + x] = { char: GLYPHS.surface.bottom, fg: BORDER_COLOR, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    // Multi-line indicator lives inside the bottom border (right-aligned) so
    // the footer height stays invariant while the user adds prompt lines.
    if (promptLines.length > 1) {
      const lineCountTag = ` ${promptLines.length}L `;
      let tx = boxStartX + boxWidth - lineCountTag.length - 2;
      for (const ch of lineCountTag) {
        if (tx >= boxStartX + boxWidth - 1) break;
        bottomLine[tx] = { char: ch, fg: '244', bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false };
        tx += 1;
      }
    }
    lines.push(bottomLine);
    // --- Composer posture block (mode / risk / status / flags) ------------
    // Suppressed in compact mode; the ctx-info line no longer duplicates these
    // tokens, so this block is the single home for mode/status/flags.
    const composerTokens: Array<{ text: string; fg: string; bold?: boolean; dim?: boolean }> = [];
    if (composerMode) composerTokens.push({ text: ` ${GLYPHS.status.active} ${composerMode} `, fg: UI_TONES.state.info, bold: true });
    if (composerPendingRisk && composerPendingRisk !== 'none') {
      const riskColor = composerPendingRisk === 'approval-wait'
        ? UI_TONES.state.warn
        : composerPendingRisk === 'shell'
          ? UI_TONES.state.bad
          : composerPendingRisk === 'remote'
            ? '#a78bfa'
            : UI_TONES.state.warn;
      composerTokens.push({ text: ` risk:${composerPendingRisk} `, fg: riskColor, bold: true });
    }
    if (composerStatus && composerStatus !== 'idle') composerTokens.push({ text: ` state:${composerStatus} `, fg: '244', dim: true });
    if (composerFlags && composerFlags.length > 0) composerTokens.push({ text: ` flags:${composerFlags.join(',')} `, fg: '244', dim: true });
    if (!compact && composerTokens.length > 0) {
      const postureLine = createBaseLine();
      let px = 2;
      for (const token of composerTokens) {
        for (const ch of token.text) {
          if (px >= width) break;
          postureLine[px] = {
            char: ch,
            fg: token.fg,
            bg: '',
            bold: token.bold ?? false,
            dim: token.dim ?? false,
            underline: false,
            italic: false,
            strikethrough: false,
          };
          px += getDisplayWidth(ch);
        }
        if (px >= width) break;
      }
      lines.push(postureLine);
    }
    const isRecentlyCopied = Date.now() - lastCopyTime < 2000;
    // Token usage line + running ~$ cost estimate (derived from the usage
    // object and the active model via cost-utils).
    const u = usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; up?: number; down?: number };
    const inp = u.input ?? u.up ?? 0;
    const out = u.output ?? u.down ?? 0;
    const cr = u.cacheRead ?? 0;
    const cw = u.cacheWrite ?? 0;
    const total = inp + out + cr + cw;
    const tokenSep = ` ${GLYPHS.navigation.pipeSeparator} `;
    const costSegment = model ? `${tokenSep}~$${fmtCost(calcSessionCost(inp, out, cr, cw, model))}` : '';
    const tokenLine = ` Token Usage [ Input: ${fmtNum(inp)}${tokenSep}Output: ${fmtNum(out)}${tokenSep}Cache Read: ${fmtNum(cr)}${tokenSep}Cache Write: ${fmtNum(cw)}${tokenSep}Total: ${fmtNum(total)}${costSegment} ]`;
    const copiedNotice = isRecentlyCopied ? ` [COPIED] ` : '';
    const statsLine = '  ' + tokenLine + ' '.repeat(Math.max(0, width - 4 - getDisplayWidth(tokenLine) - getDisplayWidth(copiedNotice))) + copiedNotice;
    lines.push(this.stringToLine(statsLine, width, { fg: isRecentlyCopied ? '81' : '244', bold: isRecentlyCopied }));
    // Context usage progress bar — suppressed in compact mode.
    if (!compact && contextWindow && contextWindow > 0) {
      const ctxTokens = lastInputTokens ?? 0;
      const label = '   Context Usage: ';
      const suffix = ` [ ${fmtNum(ctxTokens)} / ${fmtNum(contextWindow)} ]`;
      const barWidth = Math.max(10, Math.min(30, width - getDisplayWidth(label) - getDisplayWidth(suffix) - 8));
      const ctxPct = computeContextUsage(ctxTokens, contextWindow).clampedRatio;
      // Clamp threshold to [0..1]; undefined/0 means no threshold marker.
      const thresholdFraction = (compactThreshold !== undefined && compactThreshold > 0)
        ? Math.min(1, compactThreshold)
        : undefined;
      lines.push(this.createProgressBarLine(label, ctxPct, barWidth, width, suffix, thresholdFraction));
    }
    // Context info line (working dir, model+provider, tools, hitl).
    // Suppressed in compact mode. mode/status/flags are intentionally omitted —
    // the posture block above owns them, so they are not duplicated here.
    if (!compact && (workingDir || model)) {
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
      // Labeled "notify" (not "hitl") — /mode (aliased /hitl) governs UX
      // notification verbosity (quiet/balanced/operator), not tool
      // auto-approval, so it must not share vocabulary with the DANGER MODE
      // risk banner rendered a few lines below.
      if (hitlMode) ctxParts.push(`notify:${hitlMode}`);
      const ctxLine = '   ' + ctxParts.join(`  ${GLYPHS.navigation.pipeSeparator}  `);
      lines.push(this.stringToLine(truncateDisplay(ctxLine, width), width, { fg: '240', dim: true }));
    }
    if (showExitNotice) {
      const notice = `   !!! Press Ctrl+C again to exit !!! `;
      lines.push(this.stringToLine(fitDisplay(notice, width), width, { fg: '196', bold: true }));
    } else {
      // Persistent discoverability tip. Rotates by context (agent-aware): the
      // process-monitor tip leads while a turn is in flight. See footer-tips.ts.
      const help = `   ${buildFooterTip({ agentActive: isAgentActive(composerStatus) })} `;
      const dangerWarn = dangerMode ? `! DANGER MODE - ALL CHANGES AUTO-APPROVED ` : '';
      const helpW = getDisplayWidth(help);
      const dangerW = getDisplayWidth(dangerWarn);
      const spacerW = Math.max(0, width - helpW - dangerW);
      const combinedLine = help + ' '.repeat(spacerW) + dangerWarn;
      const line = this.stringToLine(truncateDisplay(combinedLine, width), width, { fg: '240', dim: true });
      // Overlay the danger warning in red bold
      if (dangerMode && dangerW > 0) {
        let col = helpW + spacerW;
        for (const ch of dangerWarn) {
          if (col >= width) break;
          const cw = getDisplayWidth(ch);
          line[col] = { char: ch, fg: UI_TONES.state.bad, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false };
          if (cw === 2 && col + 1 < width) line[col + 1] = { ...line[col], char: '' };
          col += cw;
        }
      }
      lines.push(line);
    }
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
  private static readonly THINK_GRADIENT_START = UI_TONES.accent.gradientStart;
  private static readonly THINK_GRADIENT_END = UI_TONES.accent.gradientEnd;

  public static createThinkingFragment(width: number, spinner: string, frame: number = 0, tokenSpeed?: number, toolPreview?: string, inputTokens?: number, outputTokens?: number, elapsedMs?: number, ttftMs?: number): Line[] {
    // Rotate phrase every ~30 seconds (frame ticks at 80ms, so ~375 frames)
    const phraseIndex = Math.floor(frame / PHRASE_ROTATION_FRAMES) % this.THINKING_PHRASES.length;
    const phrase = this.THINKING_PHRASES[phraseIndex];
    const speedSuffix = (tokenSpeed !== undefined && tokenSpeed > 0) ? ` (${Math.round(tokenSpeed)} tok/s)` : '';
    const elapsedSuffix = elapsedMs !== undefined ? ` (${formatElapsed(elapsedMs)})` : '';
    const ttftSuffix = (ttftMs !== undefined && ttftMs > 0) ? ` ttft:${ttftMs}ms` : '';
    const text = `  ${spinner} ${phrase}${speedSuffix}${elapsedSuffix}${ttftSuffix} `;

    const textWidth = Math.max(1, getDisplayWidth(text) - 1);
    const segments: ConversationStatusSegment[] = Array.from(text).map((char, index) => {
      const rawUnwrapped = (index / textWidth) - (frame % GRADIENT_CYCLE_FRAMES) * 0.02;
      const raw = ((rawUnwrapped % 1.0) + 1.0) % 1.0;
      const gradientPos = raw <= 0.5 ? raw * 2 : (1 - raw) * 2;
      return {
        text: char,
        fg: interpolateColor(this.THINK_GRADIENT_START, this.THINK_GRADIENT_END, gradientPos),
        bold: true,
      };
    });
    if (inputTokens !== undefined || outputTokens !== undefined) {
      const inTok = inputTokens ?? 0;
      const outTok = outputTokens ?? 0;
      segments.push({ text: ` in ${fmtNum(inTok)} `, fg: '243', dim: true });
      segments.push({ text: `out ${fmtNum(outTok)}`, fg: UI_TONES.accent.brand });
    }
    const line = createEmptyLine(width);
    let col = 1;
    for (const segment of segments) {
      for (const char of segment.text) {
        if (col >= width) break;
        const charWidth = getDisplayWidth(char);
        if (charWidth <= 0 || col + charWidth > width) break;
        line[col] = {
          char,
          fg: segment.fg,
          bg: '',
          bold: segment.bold ?? false,
          dim: segment.dim ?? false,
          underline: false,
          italic: segment.italic ?? false,
          strikethrough: false,
        };
        if (charWidth === 2 && col + 1 < width) {
          line[col + 1] = { ...line[col], char: '' };
        }
        col += charWidth;
      }
      if (col >= width) break;
    }

    const lines: Line[] = [
      this.stringToLine(' '.repeat(width), width),
      line,
    ];

    if (toolPreview) {
      const previewLine = createEmptyLine(width);
      const label = ' tool: ';
      let px = 0;
      for (const ch of label) {
        if (px >= width) break;
        previewLine[px] = {
          char: ch,
          fg: UI_TONES.state.info,
          bg: '',
          bold: true,
          dim: false,
          underline: false,
          italic: false,
          strikethrough: false,
        };
        px += getDisplayWidth(ch);
      }
      for (const ch of toolPreview) {
        if (px >= width) break;
        const charWidth = getDisplayWidth(ch);
        if (charWidth <= 0 || px + charWidth > width) break;
        previewLine[px] = {
          char: ch,
          fg: '243',
          bg: '',
          bold: false,
          dim: true,
          underline: false,
          italic: false,
          strikethrough: false,
        };
        if (charWidth === 2 && px + 1 < width) {
          previewLine[px + 1] = { ...previewLine[px], char: '' };
        }
        px += charWidth;
      }
      lines.push(previewLine);
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
   * @param suffix - Optional suffix appended after the percentage
   * @param compactThreshold - Optional fraction [0..1] at which a threshold marker is drawn
   *   and the color switches from safe to at-threshold. When omitted, falls back to the
   *   legacy hardcoded 0.6/0.85 thresholds.
   */
  private static createProgressBarLine(
    label: string,
    pct: number,
    barWidth: number,
    lineWidth: number,
    suffix?: string,
    compactThreshold?: number,
  ): Line {
    const pctDisplay = Math.round(pct * 100);
    const filled = Math.round(pct * barWidth);

    // Color: when compactThreshold is provided, switch at the threshold;
    // otherwise fall back to legacy hardcoded 0.6 (green) / 0.85 (yellow) / red.
    let color: string;
    if (compactThreshold !== undefined) {
      color = pct < compactThreshold ? '82' : pct < 1.0 ? '220' : '196';
    } else {
      color = pct < 0.6 ? '82' : pct < 0.85 ? '220' : '196';
    }

    // Build bar with optional threshold marker.
    // The marker ('▸') is placed at the threshold column, replacing an empty cell.
    const emptyChar = GLYPHS.meter.empty;
    const filledChar = GLYPHS.meter.filled;
    const thresholdCol = compactThreshold !== undefined
      ? Math.round(compactThreshold * barWidth)
      : -1;

    let bar = '';
    for (let i = 0; i < barWidth; i++) {
      if (i === thresholdCol && i >= filled) {
        // Threshold marker sits in the empty region
        bar += '▸'; // ▸
      } else {
        bar += i < filled ? filledChar : emptyChar;
      }
    }

    const pctStr = `  ${pctDisplay}%`;
    const full = label + bar + pctStr + (suffix ?? '');
    return this.stringToLine(truncateDisplay(full, lineWidth), lineWidth, { fg: color, dim: true });
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
