import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { calcSessionCost, isModelPriced } from '@pellux/goodvibes-sdk/platform/providers';
import { UIFactory } from './ui-factory.ts';
import { voiceCaptureRowVisible, type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { activeTokens, activeUiTones } from './theme.ts';
import { permissionModeLabel } from '../core/permission-mode.ts';
import { SLEEP_DISABLED_CHIP } from '../core/power-status.ts';
import { renderComposer, COMPOSER_FIXED_ROWS, type ComposerChip } from './composer.ts';
import { renderStatusLine, type StatusBusyState } from './status-line.ts';
import { voiceCaptureChip } from './voice-capture-chip.ts';
import { tagFooterLine } from './footer-targets.ts';

/**
 * shell-surface.ts, everything under the transcript: the passive hint rows
 * (retry affordance, context pressure, the scriptable status line) when they
 * have something to say, then the composer, then the one-row status line.
 *
 * At rest that is 6 rows (composer 5 + status 1). Token totals, the per-turn
 * history, tool count, notification mode, the session spine and the web
 * surface address live in the Usage modal and /status, not on the main screen.
 * What stays always visible is safety: the auto-approve warning, the live
 * microphone, the sleep-disabled chip, the failover marker (composer inner
 * row) and the compaction-pressure hint (a hint row above the composer).
 */

export interface ShellFooterBuildOptions {
  readonly width: number;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number;
  readonly promptFocused?: boolean;
  readonly usage: { up: number; down: number; cacheRead?: number; cacheWrite?: number; fleetCostUsd?: number | null };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  readonly model?: string;
  /**
   * Divergence marker shown after the model while the serving backend is not
   * the user's configured selection (core/active-model-identity.ts), e.g.
   * "failover from abacusai:route-llm". Absent/empty in the normal case.
   */
  readonly modelNote?: string;
  readonly workingDir?: string;
  /** The current branch (and dirty marker), shown beside the directory at rest. */
  readonly branch?: string;
  readonly provider?: string;
  readonly contextWindow?: number;
  readonly compactThreshold?: number;
  readonly dangerMode?: boolean;
  readonly lastInputTokens?: number;
  readonly commandArgsHint?: string;
  readonly runningAgentCount: number;
  readonly runningProcessCount: number;
  readonly indicatorFocused: boolean;
  readonly runningAgentProgress?: string;
  readonly composerFlags?: readonly string[];
  readonly composerPendingRisk?: 'none' | 'approval-wait' | 'shell' | 'command' | 'remote';
  /**
   * Current session permission mode (config value: 'prompt' | 'allow-all' |
   * 'custom' | 'plan' | 'accept-edits'). Names the composer's mode and colors
   * its bar. Cycled by Shift+Tab and toggled by /plan.
   */
  readonly permissionMode?: string;
  /** Passive context pressure hint from buildContextStatusHint, a row above the composer. */
  readonly contextStatusHint?: string | null;
  /** Output of the user's scriptable status line (`statusline.command`), a row above the composer. */
  readonly scriptableStatusLine?: string | null;
  /** The one-key retry/switch-model affordance's transient hint, topmost while armed. */
  readonly retryHint?: string | null;
  /** True while power.keepAwake holds, renders the always-visible "sleep disabled" chip. */
  readonly powerKeepAwake?: boolean;
  /** Live microphone state; a non-null visible state renders the microphone chip. */
  readonly voiceCapture?: VoiceCaptureIndicatorState | null;
  /** A running turn: its spinner, phrase and timer take the status line's left side. */
  readonly busy?: StatusBusyState | null;
}

export interface ShellFooterBuildResult {
  readonly lines: Line[];
  readonly height: number;
}

/** The status line under the composer. */
const STATUS_ROWS = 1;

/**
 * Real height of the most recently rendered footer. estimateShellFooterHeight
 * prefers it so the pre-render viewport math accounts for the hint rows the
 * static formula cannot see. Null before any footer has rendered.
 */
let lastRenderedFooterHeight: number | null = null;

/**
 * The wrapped-prompt shape the composer reports each frame, the subset
 * promptCursorOffset needs (see InputHandler.getWrappedPromptInfo).
 */
export interface WrappedPromptCursorInfo {
  readonly visibleLines: readonly string[];
  readonly visibleCursorLine: number;
  readonly visibleCursorCol: number;
}

/**
 * Flatten a wrapped-prompt cursor position (line + column) into the single
 * character offset the composer's `cursorPos` expects, counting one separator
 * per wrapped line. Undefined when the cursor is not on a visible line.
 */
export function promptCursorOffset(info: WrappedPromptCursorInfo): number | undefined {
  if (info.visibleCursorLine < 0) return undefined;
  const precedingChars = info.visibleLines
    .slice(0, info.visibleCursorLine)
    .reduce((sum: number, line: string) => sum + line.length + 1, 0);
  return precedingChars + info.visibleCursorCol;
}

/** Rows the footer will take for this many prompt rows (exact when no hint rows show). */
export function estimateShellFooterHeight(promptLineCount: number): number {
  if (lastRenderedFooterHeight !== null) return lastRenderedFooterHeight;
  return COMPOSER_FIXED_ROWS + Math.max(1, promptLineCount) + STATUS_ROWS;
}

/** The composer's mode label and bar color. */
function composerModeStyle(permissionMode: string | undefined, shell: boolean): { label: string; color: string } {
  const t = activeTokens();
  if (shell) return { label: 'shell', color: t.accent };
  switch (permissionMode) {
    case 'plan': return { label: 'plan', color: t.info };
    case 'accept-edits':
    case 'allow-all':
    case 'custom':
      return { label: permissionModeLabel(permissionMode), color: t.warning };
    default:
      return { label: permissionModeLabel(permissionMode), color: t.brand };
  }
}

/** Format a USD amount with a precision that suits its magnitude. */
function fmtCost(usd: number): string {
  if (!(usd > 0)) return '0.00';
  if (usd < 0.01) return usd.toFixed(4);
  if (usd < 1) return usd.toFixed(3);
  return usd.toFixed(2);
}

/** "~$0.246", or "you ~$0.25 · fleet ~$0.47" once delegated agents have cost something (estimates, hence the ~). */
export function statusCostText(usage: ShellFooterBuildOptions['usage'], model: string | undefined): string | null {
  const inp = usage.up;
  const out = usage.down;
  const main = model && isModelPriced(model)
    ? `~$${fmtCost(calcSessionCost(inp, out, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, model))}`
    : null;
  const fleet = usage.fleetCostUsd;
  if (typeof fleet === 'number' && fleet > 0) return `you ${main ?? '~n/a'} · fleet ~$${fmtCost(fleet)}`;
  return main;
}

function displayDirectory(workingDir: string | undefined): string | undefined {
  if (!workingDir) return undefined;
  const home = typeof process !== 'undefined' ? process.env.HOME ?? '' : '';
  return home && workingDir.startsWith(home) ? '~' + workingDir.slice(home.length) : workingDir;
}

export function buildShellFooter(options: ShellFooterBuildOptions): ShellFooterBuildResult {
  const t = activeTokens();
  const lines: Line[] = [];
  // Passive hint rows, topmost first: the retry affordance (actionable, time
  // bounded), the context pressure hint, then the user's scriptable line.
  if (options.retryHint) lines.push(UIFactory.stringToLine(`   ${options.retryHint}`, options.width, { fg: t.textMuted, bold: true }));
  if (options.contextStatusHint) lines.push(UIFactory.stringToLine(`   ${options.contextStatusHint}`, options.width, { fg: t.textMuted }));
  if (options.scriptableStatusLine) lines.push(UIFactory.stringToLine(`   ${options.scriptableStatusLine}`, options.width, { fg: t.textMuted }));

  const focused = options.promptFocused ?? !options.indicatorFocused;
  const mode = composerModeStyle(options.permissionMode, options.composerPendingRisk === 'shell');
  const chips: ComposerChip[] = [];
  if (options.dangerMode) chips.push({ text: '! auto-approve', fg: t.error, bold: true, keep: true });
  const voice = options.voiceCapture ?? null;
  if (voice && voiceCaptureRowVisible(voice)) chips.push(voiceCaptureChip(voice));
  if (options.powerKeepAwake) chips.push({ text: SLEEP_DISABLED_CHIP, fg: t.warning, bold: true, keep: true });
  // The chips are listed right to left in priority; draw them left to right.
  chips.reverse();
  lines.push(...renderComposer({
    width: options.width,
    promptText: options.promptText,
    cursorPos: options.promptCursorPos,
    focused,
    unfocusedHint: 'Esc returns to the composer',
    argsHint: options.commandArgsHint,
    modeLabel: mode.label,
    modeColor: mode.color,
    model: options.model,
    provider: options.provider,
    modelNote: options.modelNote,
    // An orchestration request leaves this terminal: its flag carries the remote color.
    flags: (options.composerFlags ?? []).filter((f) => f !== 'shell').map((f) => (
      f === 'orchestration' && options.composerPendingRisk === 'remote' ? { text: f, fg: activeUiTones().chrome.remote } : f
    )),
    chips,
  }));

  const copied = Date.now() - options.lastCopyTime < 2000;
  // A click anywhere on the status line (the context bar, the cost) opens Usage.
  lines.push(tagFooterLine(renderStatusLine({
    width: options.width,
    notice: options.showExitNotice
      ? { text: 'Press Ctrl+C again to exit', tone: 'error' }
      : copied ? { text: 'Copied', tone: 'info' } : null,
    busy: options.busy ?? null,
    directory: displayDirectory(options.workingDir),
    branch: options.branch,
    background: {
      agents: options.runningAgentCount,
      processes: options.runningProcessCount,
      focused: options.indicatorFocused,
      progress: options.runningAgentProgress,
    },
    cost: statusCostText(options.usage, options.model),
    context: options.contextWindow && options.contextWindow > 0
      ? {
          usedTokens: options.lastInputTokens ?? 0,
          windowTokens: options.contextWindow,
          compactFraction: options.compactThreshold && options.compactThreshold > 0 ? options.compactThreshold : 0.85,
        }
      : null,
  }), 'usage'));
  lastRenderedFooterHeight = lines.length;
  return { lines, height: lines.length };
}
