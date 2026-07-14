import { type Line, type Cell, createEmptyLine, createEmptyCell } from '../types/grid.ts';
import { LAYOUT } from './layout.ts';
import { VERSION } from '../version.ts';
import { fitDisplay, getDisplayWidth, truncateDisplay, wrapText, interpolateColor, joinPrioritizedSegments, type PrioritizedSegment } from '../utils/terminal-width.ts';
import type { GitHeaderInfo } from './git-status.ts';
import { renderConversationFragment, renderConversationStatusLine, type ConversationStatusSegment } from './conversation-surface.ts';
import { GLYPHS } from './ui-primitives.ts';
import { activeUiTones } from './theme.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { computeContextUsage } from '../core/context-usage.ts';
import { permissionModeLabel, permissionModeTone } from '../core/permission-mode.ts';
import { calcSessionCost, isModelPriced } from '../export/cost-utils.ts';
import { buildFooterTip, isAgentActive } from './footer-tips.ts';
import type { StreamMetrics } from '../core/stream-event-wiring.ts';
import { waitingPhrase, type WaitingState } from '@pellux/goodvibes-sdk/platform/presentation';

/** Number of frames before the animated gradient completes one full cycle. */
const GRADIENT_CYCLE_FRAMES = 50;
/**
 * Ms since the last STREAM_DELTA before the whimsical phrase rotation freezes
 * and createThinkingFragment shows an honest "stalled Ns" / "reconnecting"
 * label instead. Deliberately much shorter than the 30s stream-stall-watchdog
 * hint threshold (stream-stall-watchdog.ts) — that threshold gates a
 * low-priority system message about a likely-dead connection; this one gates
 * a cosmetic label so the UI stops claiming "Vibing..." within a couple of
 * seconds of real silence, well before the stall is confirmed as a problem.
 */
const THINKING_STALL_FREEZE_MS = 2_500;

/**
 * Stall/reconnect state for the live thinking indicator, computed by the
 * caller every render frame from streamMetrics (see stream-event-wiring.ts).
 * `reconnect` is populated only once the SDK's STREAM_RETRY event fires
 * (structurally consumed — absent from SDK 0.35.0's TurnEvent union today).
 */
export interface ThinkingStallInfo {
  /** Ms since the last STREAM_DELTA (or STREAM_START if none yet this turn). */
  readonly msSinceLastDelta: number;
  readonly reconnect?: { readonly attempt: number; readonly maxAttempts: number };
}

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
  // `version` defaults to the live build VERSION; tests pass a pinned fixture so
  // golden snapshots don't break on every release bump (version-decoupled goldens,
  // mirroring the splash fixture-version pattern).
  public static createHeader(width: number, model: string, provider: string, title?: string, gitInfo?: GitHeaderInfo, version: string = VERSION): Line[] {
    const lines: Line[] = [];
    // Header/footer/thinking paint on the transparent terminal background, so
    // they read chrome.* (light-terminal-aware) — NOT fg.*/state.*, which stay
    // tuned for the opaque dark modal/panel boxes. Read live per render so a
    // mode flip re-resolves without any module reload (see theme.ts).
    const t = activeUiTones();
    const CYAN = t.accent.brand;
    const GREY = t.chrome.faint;
    const TITLE_COLOR = t.chrome.label;
    const brand = ` GoodVibes `;
    const ver = `v${version} `;
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
    let gitFg: string = t.chrome.faint;
    if (gitInfo) {
      gitStr = buildGitSegment(gitInfo).text;
      if (gitInfo.dirty || gitInfo.ahead > 0 || gitInfo.behind > 0) {
        gitFg = t.chrome.warn; // yellow when dirty or out-of-sync
      }
    }
    const rightSideText = stats + prov;
    const rightSideW = getDisplayWidth(rightSideText) + getDisplayWidth(gitStr);
    let rightX = width - rightSideW;
    for (const char of gitStr) { if (rightX >= 0 && rightX < width) line[rightX++] = { char, fg: gitFg, bg: '', bold: false, dim: !gitInfo?.dirty && !(gitInfo?.ahead || gitInfo?.behind), underline: false, italic: false, strikethrough: false }; }
    for (const char of stats) { if (rightX < width) line[rightX++] = { char, fg: CYAN, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false }; }
    for (const char of prov) { if (rightX < width) line[rightX++] = { char, fg: GREY, bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false }; }
    lines.push(line);
    lines.push(this.stringToLine('━'.repeat(width), width, { fg: t.chrome.faint }));
    return lines;
  }

  /**
   * createMessageBar - Renders a historical user message.
   * Logic: Calculates the longest line to create a "hugging" block.
   */
  public static createMessageBar(
    width: number, text: string,
    bgColor: string = '#2a2a2a', textColor: string = activeUiTones().fg.secondary, prefixStr: string = ' › ',
    strikethrough = false
  ): Line[] {
    // A historical user-message pill: it carries its own dark bodyBg, so its fg
    // reads fg.secondary/state.reasoning (light-on-dark) — this is conversation
    // content, not the transparent-terminal chrome, so it is not part of the
    // light-terminal chrome flip.
    return renderConversationFragment(text, width, {
      prefix: prefixStr,
      prefixFg: activeUiTones().state.reasoning,
      text: textColor,
      bodyBg: bgColor,
      strikethrough,
    });
  }

  /**
   * createQueuedMessageFragment - Renders a dimmed message bar for queued prompts.
   */
  public static createQueuedMessageFragment(width: number, text: string): Line[] {
    const t = activeUiTones();
    return renderConversationFragment(text, width, {
      prefix: ' (...) ',
      prefixFg: t.state.reasoning,
      text: t.fg.dim,
      bodyBg: '#1a1a1a',
      dim: true,
    });
  }

  /**
   * createQueuedMessageList — the mid-turn queue rendered as an EDITABLE list.
   *
   * Each still-undelivered message shows a 1-based number so it can be named to
   * `/queue edit <n> …` / `/queue delete <n>`, which drive the SDK's
   * editQueuedMessage / deleteQueuedMessage verbs. A delivered message has
   * already left the queue (it is no longer listed), so the list only ever
   * shows what is still editable — delivery is immutability, made visible. The
   * header states the affordance so the capability is discoverable.
   */
  public static createQueuedMessageList(width: number, items: readonly { readonly id: string; readonly text: string }[]): Line[] {
    if (items.length === 0) return [];
    const t = activeUiTones();
    const lines: Line[] = [];
    const header = `${items.length} queued — /queue edit·delete until delivered`;
    lines.push(...renderConversationFragment(header, width, {
      prefix: ' ⧗ ',
      prefixFg: t.state.reasoning,
      text: t.fg.dim,
      bodyBg: '#1a1a1a',
      dim: true,
    }));
    items.forEach((item, index) => {
      lines.push(...renderConversationFragment(item.text, width, {
        prefix: `   ${index + 1}. `,
        prefixFg: t.state.reasoning,
        text: t.fg.dim,
        bodyBg: '#1a1a1a',
        dim: true,
      }));
    });
    return lines;
  }

  public static createFooter(
    width: number,
    prompt: string,
    usage: { up: number; down: number; max?: number; fleetCostUsd?: number | null },
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
    // Honest cross-surface spine posture. Defined ONLY in adopted-daemon
    // mode (undefined in embedded/local), so the segment is absent otherwise.
    sessionSpineStatus?: 'online' | 'offline',
    // Session permission mode (config value). Rendered as a leading pill in the
    // posture block; undefined suppresses the pill (e.g. bare test callers).
    permissionMode?: string,
    // The web surface's reachable URL, when that surface is enabled — a
    // persistent low-priority context segment; undefined suppresses it.
    webSurfaceUrl?: string,
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

      // focus visibility (item 1c): when the panel workspace owns focus
      // and the composer is empty, name the state and the way back — the
      // dimmed prompt alone (TEXT_COLOR/BG_COLOR above) told you nothing was
      // wrong, but not why keystrokes weren't landing here.
      if (!promptFocused && text === '' && i === 0) {
        const hintText = 'panel focused — Esc returns';
        const hintStartX = boxStartX + 2 + prefix.length;
        let hx = hintStartX;
        for (const ch of hintText) {
          if (hx >= boxStartX + boxWidth - 2) break;
          contentLine[hx] = { char: ch, fg: '244', bg: BG_COLOR, bold: false, dim: true, underline: false, italic: false, strikethrough: false };
          hx++;
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
          const hintLimit = boxStartX + boxWidth - 2; // exclusive right bound
          const avail = Math.max(0, hintLimit - hintStartX);
          // Clamp to the available width with an ellipsis so a long arg-spec
          // (e.g. /marketplace) ends in "…" rather than a hard mid-word cut. (5b)
          let hintText = ' ' + commandArgsHint;
          if (hintText.length > avail) {
            hintText = avail > 1 ? `${hintText.slice(0, avail - 1)}…` : hintText.slice(0, Math.max(0, avail));
          }
          let hx = hintStartX;
          for (const ch of hintText) {
            if (hx >= hintLimit) break;
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
    // Footer chrome paints on the transparent terminal bg → chrome.* accents
    // (light-terminal-aware); state.info reads on both light and dark terminals.
    const t = activeUiTones();
    const composerTokens: Array<{ text: string; fg: string; bold?: boolean; dim?: boolean }> = [];
    // Permission-mode pill — always shown so the active session posture (normal
    // / plan / accept-edits / auto) is visible at a glance. Tone: normal reads
    // dim/neutral, plan reads info (read-only, safe), accept-edits and auto read
    // as caution (raised autonomy). Cycled by Shift+Tab, toggled by /plan.
    if (permissionMode) {
      const modeTone = permissionModeTone(permissionMode);
      const modeFg = modeTone === 'caution' ? t.chrome.warn : modeTone === 'info' ? t.state.info : '244';
      composerTokens.push({ text: ` mode:${permissionModeLabel(permissionMode)} `, fg: modeFg, bold: modeTone !== 'neutral', dim: modeTone === 'neutral' });
    }
    // Context-usage chip — always-visible compaction-pressure indicator so the
    // user sees compaction approaching before it happens. Colored by proximity
    // to the auto-compact threshold (fraction; falls back to 0.85 when unset).
    if (contextWindow && contextWindow > 0) {
      const ctxUsage = computeContextUsage(lastInputTokens ?? 0, contextWindow);
      const ctxThr = compactThreshold && compactThreshold > 0 ? compactThreshold : 0.85;
      const ctxFg = ctxUsage.clampedRatio >= ctxThr ? t.chrome.bad : ctxUsage.clampedRatio >= ctxThr * 0.85 ? t.chrome.warn : '244';
      composerTokens.push({ text: ` ctx:${ctxUsage.pct}% `, fg: ctxFg, bold: ctxUsage.clampedRatio >= ctxThr, dim: ctxUsage.clampedRatio < ctxThr * 0.85 });
    }
    if (composerMode) composerTokens.push({ text: ` ${GLYPHS.status.active} ${composerMode} `, fg: t.state.info, bold: true });
    if (composerPendingRisk && composerPendingRisk !== 'none') {
      const riskColor = composerPendingRisk === 'approval-wait'
        ? t.chrome.warn
        : composerPendingRisk === 'shell'
          ? t.chrome.bad
          : composerPendingRisk === 'remote'
            ? t.chrome.remote
            : t.chrome.warn;
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
    const u = usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; up?: number; down?: number; fleetCostUsd?: number | null };
    const inp = u.input ?? u.up ?? 0;
    const out = u.output ?? u.down ?? 0;
    const cr = u.cacheRead ?? 0;
    const cw = u.cacheWrite ?? 0;
    const total = inp + out + cr + cw;
    const tokenSep = ` ${GLYPHS.navigation.pipeSeparator} `;
    // 'n/a' (not 'unpriced') to stay compact in the single-line footer and
    // match the existing "no priceable data" convention used elsewhere
    // (cockpit-panel formatCost, agent-inspector-shared) — the footer has no
    // room for a longer marker before truncation kicks in.
    const mainCostStr = model
      ? isModelPriced(model)
        ? `~$${fmtCost(calcSessionCost(inp, out, cr, cw, model))}`
        : '~n/a'
      : null;
    // Honest total = your main session + the delegated fleet. We show a SPLIT
    // ("you ~$X · fleet ~$Y") rather than one summed figure: the two costs are
    // tracked and attributed to different actors, and the split directly answers
    // "where did the money go" — the exact confusion in the eval where the footer
    // showed only the main session (~$0.046) while the fleet cost ~10x more
    // ($0.446). The fleet segment appears only when there is a real fleet cost, so
    // the idle single-session footer is unchanged.
    const fleetCost = u.fleetCostUsd;
    const hasFleetCost = typeof fleetCost === 'number' && fleetCost > 0;
    const costSegment = hasFleetCost
      ? `${tokenSep}you ${mainCostStr ?? '~n/a'} · fleet ~$${fmtCost(fleetCost)}`
      : mainCostStr
        ? `${tokenSep}${mainCostStr}`
        : '';
    // Input tokens are unknown until the first assistant usage lands (often the
    // first tool turn). Show "—" rather than a false 0 during that window. (5c)
    const inpDisplay = inp > 0 ? fmtNum(inp) : '—';
    const tokenLine = ` Token Usage [ Input: ${inpDisplay}${tokenSep}Output: ${fmtNum(out)}${tokenSep}Cache Read: ${fmtNum(cr)}${tokenSep}Cache Write: ${fmtNum(cw)}${tokenSep}Total: ${fmtNum(total)}${costSegment} ]`;
    const copiedNotice = isRecentlyCopied ? ` [COPIED] ` : '';
    const statsLine = '  ' + tokenLine + ' '.repeat(Math.max(0, width - 4 - getDisplayWidth(tokenLine) - getDisplayWidth(copiedNotice))) + copiedNotice;
    lines.push(this.stringToLine(statsLine, width, { fg: isRecentlyCopied ? '81' : '244', bold: isRecentlyCopied }));
    // Context usage progress bar — suppressed in compact mode.
    if (!compact && contextWindow && contextWindow > 0) {
      const ctxTokens = lastInputTokens ?? 0;
      const label = '   Context Usage: ';
      // "—" until the first input-token count is known, not a false 0. (5c)
      const ctxDisplay = ctxTokens > 0 ? fmtNum(ctxTokens) : '—';
      const suffix = ` [ ${ctxDisplay} / ${fmtNum(contextWindow)} ]`;
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
      // Segments carry a survival priority (lower = survives longer) so that
      // under width pressure whole low-value segments are dropped before any
      // segment is character-truncated mid-word. cwd/model are the essential
      // orientation segments (priority 0); the spine liveness marker is the
      // daemon-honesty signal and must outlive the two decorative segments
      // (tool count, notify mode) — it is ordered ahead of them too, so a
      // narrow line drops "N tools"/"notify:x" whole before spine is at risk.
      const ctxParts: PrioritizedSegment[] = [];
      if (displayDir) ctxParts.push({ text: displayDir, priority: 0 });
      if (model) {
        ctxParts.push({ text: model + (provider ? ` (${provider})` : ''), priority: 0 });
      }
      // Cross-surface spine posture — plain words, no blame. Adopted mode only.
      if (sessionSpineStatus) ctxParts.push({ text: `spine:${sessionSpineStatus}`, priority: 1 });
      // Web surface reachability — plain, persistent; dropped first under width pressure.
      if (webSurfaceUrl) ctxParts.push({ text: `web:${webSurfaceUrl}`, priority: 2 });
      if (toolCount) ctxParts.push({ text: `${toolCount} tools`, priority: 2 });
      // Labeled "notify" (not "hitl") — /mode (aliased /hitl) governs UX
      // notification verbosity (quiet/balanced/operator), not tool
      // auto-approval, so it must not share vocabulary with the DANGER MODE
      // risk banner rendered a few lines below. Lowest priority: dropped first.
      if (hitlMode) ctxParts.push({ text: `notify:${hitlMode}`, priority: 3 });
      const sep = `  ${GLYPHS.navigation.pipeSeparator}  `;
      const ctxBody = joinPrioritizedSegments(ctxParts, sep, width - 3);
      const ctxLine = '   ' + ctxBody;
      lines.push(this.stringToLine(ctxLine, width, { fg: '240', dim: true }));
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
          line[col] = { char: ch, fg: t.chrome.bad, bg: '', bold: true, dim: false, underline: false, italic: false, strikethrough: false };
          if (cw === 2 && col + 1 < width) line[col + 1] = { ...line[col], char: '' };
          col += cw;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  // The rotating "thinking" phrase pool and the honest waiting-state
  // wording (approval/reconnecting/pre-first-token/stalled/thinking) are no
  // longer minted here. They come from the SDK presentation contract's
  // waitingPhrase() (@pellux/goodvibes-sdk/platform/presentation, already
  // adopted by the agent) — see createThinkingFragment
  // below. This renderer still decides WHICH state applies from its own
  // stall/reconnect/approval signals (computeStallInfo/computeRenderStallInfo
  // stay renderer-local per the extraction decision record); only the exact
  // wording is shared.

  // Gradient colors for thinking text — cyan→purple in dark, teal→purple in
  // light (matches splash/brand). Read live per render inside
  // createThinkingFragment via activeUiTones() rather than baked into a static
  // field, so a mode flip re-resolves without a module reload.

  /**
   * Per-frame stall info from stream metrics — computed from lastDeltaAtMs every render (not
   * from any event) so it degrades gracefully with zero new SDK events. Undefined until the
   * first delta clock exists this turn.
   */
  public static computeStallInfo(lastDeltaAtMs: number | undefined, reconnectAttempt: number | undefined, reconnectMaxAttempts: number | undefined, nowMs: number): ThinkingStallInfo | undefined {
    if (lastDeltaAtMs === undefined) return undefined;
    const reconnect = reconnectAttempt !== undefined && reconnectMaxAttempts !== undefined
      ? { attempt: reconnectAttempt, maxAttempts: reconnectMaxAttempts }
      : undefined;
    return { msSinceLastDelta: nowMs - lastDeltaAtMs, reconnect };
  }

  /**
   * Render-frame stall-info decision used at the main render loop's call
   * site: suppress stall detection entirely while a tool is actively
   * executing. lastDeltaAtMs only tracks STREAM_START/STREAM_DELTA and is
   * never advanced during tool execution (the model isn't producing tokens
   * then), so without this gate any tool call longer than
   * THINKING_STALL_FREEZE_MS would make the thinking fragment print
   * "Stalled Ns..." directly above the ticking "executing (Ns)" tool row — a
   * false positive during ordinary tool execution (see stream-event-wiring.ts
   * TOOL_EXECUTING/TOOL_SUCCEEDED/TOOL_FAILED/TOOL_CANCELLED handlers).
   * Genuine no-delta silence while waiting on the provider — including the
   * pre-first-token case, where lastDeltaAtMs is seeded at STREAM_START —
   * still stall-detects normally here, since no tool is active then; that is
   * the honest stall case this indicator exists for.
   */
  public static computeRenderStallInfo(
    metrics: Pick<StreamMetrics, 'activeToolName' | 'lastDeltaAtMs' | 'reconnectAttempt' | 'reconnectMaxAttempts'>,
    nowMs: number,
  ): ThinkingStallInfo | undefined {
    return metrics.activeToolName === undefined
      ? this.computeStallInfo(metrics.lastDeltaAtMs, metrics.reconnectAttempt, metrics.reconnectMaxAttempts, nowMs)
      : undefined;
  }

  public static createThinkingFragment(width: number, spinner: string, frame: number = 0, tokenSpeed?: number, toolPreview?: string, inputTokens?: number, outputTokens?: number, elapsedMs?: number, ttftMs?: number, stallInfo?: ThinkingStallInfo, approvalPending?: boolean): Line[] {
    // Live thinking row paints on the transparent terminal bg → read the
    // mode-resolved chrome tones per render (gradient/brand/tool accents flip).
    const tones = activeUiTones();
    // Freeze the whimsical phrase rotation once real silence has gone on
    // long enough to be misleading (THINKING_STALL_FREEZE_MS). Decide WHICH
    // honest waiting state applies (renderer-local — this signal computation
    // stays here per the extraction decision record), then defer the exact
    // wording to the SDK presentation contract's waitingPhrase() (which
    // mirrors the agent's adoption). Precedence matches the contract:
    // approval > reconnecting > pre-first-token > stalled > thinking.
    const isStalled = stallInfo !== undefined && stallInfo.msSinceLastDelta >= THINKING_STALL_FREEZE_MS;
    let state: WaitingState;
    if (approvalPending) state = 'approval';
    else if (stallInfo?.reconnect) state = 'reconnecting';
    else if (isStalled && (outputTokens ?? 0) === 0) state = 'pre-first-token';
    else if (isStalled) state = 'stalled';
    else state = 'thinking';
    const phrase = waitingPhrase(state, {
      reconnectAttempt: stallInfo?.reconnect?.attempt,
      reconnectMaxAttempts: stallInfo?.reconnect?.maxAttempts,
      msSinceLastDelta: stallInfo?.msSinceLastDelta,
      frame,
    });
    // Token-rate and time-to-first-token readouts are meaningless while waiting on the user, and a
    // "tok/s" figure next to an approval prompt reads as if the model were still working — suppress
    // them; keep the elapsed timer since "how long the approval has waited" is honest.
    const speedSuffix = (!approvalPending && tokenSpeed !== undefined && tokenSpeed > 0) ? ` (${Math.round(tokenSpeed)} tok/s)` : '';
    const elapsedSuffix = elapsedMs !== undefined ? ` (${formatElapsed(elapsedMs)})` : '';
    const ttftSuffix = (!approvalPending && ttftMs !== undefined && ttftMs > 0) ? ` ttft:${ttftMs}ms` : '';
    const text = `  ${spinner} ${phrase}${speedSuffix}${elapsedSuffix}${ttftSuffix} `;

    const textWidth = Math.max(1, getDisplayWidth(text) - 1);
    const segments: ConversationStatusSegment[] = Array.from(text).map((char, index) => {
      const rawUnwrapped = (index / textWidth) - (frame % GRADIENT_CYCLE_FRAMES) * 0.02;
      const raw = ((rawUnwrapped % 1.0) + 1.0) % 1.0;
      const gradientPos = raw <= 0.5 ? raw * 2 : (1 - raw) * 2;
      return {
        text: char,
        fg: interpolateColor(tones.accent.gradientStart, tones.accent.gradientEnd, gradientPos),
        bold: true,
      };
    });
    if (inputTokens !== undefined || outputTokens !== undefined) {
      const inTok = inputTokens ?? 0;
      const outTok = outputTokens ?? 0;
      segments.push({ text: ` in ${fmtNum(inTok)} `, fg: '243', dim: true });
      segments.push({ text: `out ${fmtNum(outTok)}`, fg: tones.accent.brand });
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
          fg: tones.state.info,
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
