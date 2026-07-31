import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { renderProcessIndicator, renderVoiceCaptureIndicator } from './process-indicator.ts';
import { UIFactory } from './ui-factory.ts';
import { voiceCaptureRowVisible, type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';

export interface ShellFooterBuildOptions {
  readonly width: number;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number;
  readonly promptFocused?: boolean;
  /**
   * True when the panel workspace owns keyboard focus. Only consulted as a
   * fallback when `promptFocused` is not supplied — see buildShellFooter's
   * default expression. Callers that already compute `promptFocused`
   * themselves (main.ts does) do not need to also pass this.
   */
  readonly panelFocused?: boolean;
  readonly usage: { up: number; down: number; fleetCostUsd?: number | null };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  readonly model?: string;
  /**
   * Divergence marker appended to the model segment while the serving backend
   * is not the user's configured selection (core/active-model-identity.ts),
   * e.g. "failover from abacusai:route-llm". Absent/empty in the normal case,
   * where the context-info line renders exactly as it always has.
   */
  readonly modelNote?: string;
  readonly toolCount?: number;
  readonly workingDir?: string;
  readonly provider?: string;
  readonly contextWindow?: number;
  readonly compactThreshold?: number;
  readonly dangerMode?: boolean;
  readonly lastInputTokens?: number;
  readonly commandArgsHint?: string;
  readonly hitlMode?: string;
  readonly runningAgentCount: number;
  readonly runningProcessCount: number;
  readonly indicatorFocused: boolean;
  readonly runningAgentProgress?: string;
  readonly composerMode?: string;
  readonly composerStatus?: string;
  readonly composerFlags?: readonly string[];
  readonly composerPendingRisk?: 'none' | 'approval-wait' | 'shell' | 'command' | 'remote';
  /**
   * Current session permission mode (config value: 'prompt' | 'allow-all' |
   * 'custom' | 'plan' | 'accept-edits'). Rendered as a pill in the composer
   * posture block. Cycled by Shift+Tab and toggled by /plan.
   */
  readonly permissionMode?: string;
  /**
   * Passive context pressure hint from buildContextStatusHint.
   * Rendered as a dim informational line above the prompt when non-null.
   */
  readonly contextStatusHint?: string | null;
  /**
   * Output of the user's scriptable status line (`statusline.command`).
   * Rendered as a dim informational line above the prompt when non-null,
   * below the context pressure hint.
   */
  readonly scriptableStatusLine?: string | null;
  /**
   * The one-key retry/switch-model affordance's transient hint text (see
   * retry-affordance.ts). Rendered as its own line ABOVE the context
   * pressure hint while armed; present here only means "show it now" — the
   * caller is responsible for passing null the instant it disarms, so this
   * is a time-bounded status line, never a lingering claim.
   */
  readonly retryHint?: string | null;
  /**
   * Compact footer posture for short terminals (~<30 rows). Collapses the
   * footer to its essentials (prompt box + token/cost line + help) and drops
   * the process indicator, context bar, context-info line and posture block.
   */
  readonly compact?: boolean;
  /**
   * Cross-surface session-spine posture for the context-info segment.
   * Set ONLY in adopted-daemon mode ('online'/'offline'); left undefined in
   * embedded/local mode so no segment renders.
   */
  readonly sessionSpineStatus?: 'online' | 'offline';
  /** The web surface's reachable URL, when that surface is enabled; a persistent footer segment. */
  readonly webSurfaceUrl?: string;
  /** True while power.keepAwake holds — renders the always-visible "sleep disabled" chip. */
  readonly powerKeepAwake?: boolean;
  /**
   * Live microphone state — a push-to-talk recording, or the wake detector for
   * as long as it runs. Rendered as a persistent row beside the process
   * indicator, because a capture device held open with nothing on screen saying
   * so is the one state a voice feature must never be in. Null (or a wake state
   * with `voice.wake.indicator: off`) renders nothing.
   */
  readonly voiceCapture?: VoiceCaptureIndicatorState | null;
}

export interface ShellFooterBuildResult {
  readonly lines: Line[];
  readonly height: number;
}

// Fixed rows that createFooter always emits (non-compact): prompt-box top
// border, prompt-box bottom border, token-usage line, context-info line, and
// the help/exit line. The composer posture block and context bar are counted
// separately (they are conditional).
const FOOTER_BASE_ROWS = 5;
const CONTEXT_PROGRESS_ROWS = 1;
const PROCESS_INDICATOR_ROWS = 1;
/** The live-microphone row, when one is showing (see renderVoiceCaptureIndicator). */
const VOICE_CAPTURE_ROWS = 1;
// Compact posture drops the context-info line (and never shows the context
// bar or process indicator), leaving just: prompt-box top border, bottom
// border, token-usage line, and the help/exit line.
const COMPACT_FOOTER_BASE_ROWS = 4;

// Dim slate foreground shared by the passive footer status lines (context
// pressure hint and the scriptable status line).
const DIM_STATUS_FG = '#64748b';

/**
 * Real height of the most recently rendered footer, tagged with the compact
 * posture it was rendered under. estimateShellFooterHeight prefers this so
 * the pre-prompt viewport math accounts for the composer posture block and
 * context hint that the static formula cannot see. Reset to null before any
 * footer has rendered (cold start), where the formula is exact for the
 * common posture-free, hint-free case. The compact flag is part of the cache
 * key: a cached non-compact height must never answer a compact query (and
 * vice versa), since the two postures differ by several rows.
 */
let lastRenderedFooterHeight: { compact: boolean; height: number } | null = null;

/**
 * The wrapped-prompt shape the composer reports each frame — the subset
 * promptCursorOffset needs (see InputHandler.getWrappedPromptInfo).
 */
export interface WrappedPromptCursorInfo {
  readonly visibleLines: readonly string[];
  readonly visibleCursorLine: number;
  readonly visibleCursorCol: number;
}

/**
 * Flatten a wrapped-prompt cursor position (line + column) into the single
 * character offset createFooter's `cursorPos` expects, counting one separator
 * per wrapped line. Returns undefined when the cursor is not on a visible line
 * (scrolled out of the composer's window), which suppresses the cursor overlay
 * rather than drawing it in the wrong place.
 *
 * Lives here rather than inline at the render site so main.ts (a composition
 * root already at the source-line gate) stays a wiring file.
 */
export function promptCursorOffset(info: WrappedPromptCursorInfo): number | undefined {
  if (info.visibleCursorLine < 0) return undefined;
  const precedingChars = info.visibleLines
    .slice(0, info.visibleCursorLine)
    .reduce((sum: number, line: string) => sum + line.length + 1, 0);
  return precedingChars + info.visibleCursorCol;
}

export function estimateShellFooterHeight(
  promptLineCount: number,
  contextWindow?: number,
  compact = false,
  voiceCapture: VoiceCaptureIndicatorState | null = null,
): number {
  if (lastRenderedFooterHeight !== null && lastRenderedFooterHeight.compact === compact) {
    return lastRenderedFooterHeight.height;
  }
  const safePromptLines = Math.max(1, promptLineCount);
  if (compact) {
    return COMPACT_FOOTER_BASE_ROWS + safePromptLines;
  }
  const progressRows = contextWindow && contextWindow > 0 ? CONTEXT_PROGRESS_ROWS : 0;
  // Counted on the cold-start path too: a shell launched with the wake detector
  // already listening renders that row in its very first frame, and a viewport
  // sized one row too tall would draw the transcript's last line under it.
  const voiceRows = voiceCaptureRowVisible(voiceCapture) ? VOICE_CAPTURE_ROWS : 0;
  return FOOTER_BASE_ROWS + safePromptLines + progressRows + PROCESS_INDICATOR_ROWS + voiceRows;
}

export function buildShellFooter(
  options: ShellFooterBuildOptions,
): ShellFooterBuildResult {
  const lines = UIFactory.createFooter(
    options.width,
    options.promptText,
    options.usage,
    options.showExitNotice,
    options.lastCopyTime,
    options.model,
    options.toolCount,
    options.promptCursorPos,
    options.workingDir,
    options.provider,
    options.contextWindow,
    options.compactThreshold,
    options.dangerMode,
    options.lastInputTokens,
    options.commandArgsHint,
    options.hitlMode,
    options.promptFocused ?? (!options.indicatorFocused && !options.panelFocused),
    options.composerMode,
    options.composerStatus,
    options.composerFlags,
    options.composerPendingRisk,
    options.compact ?? false,
    options.sessionSpineStatus,
    options.permissionMode,
    options.webSurfaceUrl,
    options.powerKeepAwake,
    options.modelNote,
  );
  // Compact posture drops the process indicator and context hint entirely so
  // the footer fits within ~5 rows on short terminals.
  if (!options.compact) {
    const processIndicator = renderProcessIndicator(
      options.width,
      options.runningAgentCount,
      options.runningProcessCount,
      options.indicatorFocused,
      options.runningAgentProgress,
    );
    const inputBoxRows = Math.max(1, options.promptLineCount) + 2;
    // The voice row sits directly under the prompt box, ABOVE the process
    // indicator: an open microphone is a live condition the user is acting inside,
    // while the process indicator is a background summary.
    lines.splice(inputBoxRows, 0, ...renderVoiceCaptureIndicator(options.width, options.voiceCapture ?? null), ...processIndicator);
    // Scriptable status line — dim informational line above the prompt. Unshifted
    // before the context hint so the context hint (if any) sits above it.
    if (options.scriptableStatusLine) {
      lines.unshift(UIFactory.stringToLine(options.scriptableStatusLine, options.width, { fg: DIM_STATUS_FG }));
    }
    // Passive context status hint — rendered as a dim informational line before the prompt.
    if (options.contextStatusHint) {
      const hintLine = UIFactory.stringToLine(options.contextStatusHint, options.width, { fg: DIM_STATUS_FG });
      lines.unshift(hintLine);
    }
    // Retry affordance — topmost of the passive hint lines while armed (an
    // actionable, time-bounded prompt outranks the passive status hints
    // below it); simply absent the instant it disarms.
    if (options.retryHint) {
      const retryLine = UIFactory.stringToLine(options.retryHint, options.width, { fg: DIM_STATUS_FG, bold: true });
      lines.unshift(retryLine);
    }
  }
  lastRenderedFooterHeight = { compact: options.compact ?? false, height: lines.length };
  return { lines, height: lines.length };
}
