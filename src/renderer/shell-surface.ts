import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { calcSessionCost, isModelPriced } from '@pellux/goodvibes-sdk/platform/providers';
import { UIFactory } from './ui-factory.ts';
import { voiceCaptureRowVisible, type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { activeTokens, activeUiTones } from './theme.ts';
import { permissionModeLabel } from '../core/permission-mode.ts';
import { SLEEP_DISABLED_CHIP } from '../core/power-status.ts';
import { renderComposer, COMPOSER_FIXED_ROWS } from './composer.ts';
import { renderStatusLine, type StatusBusyState, type StatusChip } from './status-line.ts';
import { voiceCaptureChip } from './voice-capture-chip.ts';
import { tagFooterLine } from './footer-targets.ts';

/**
 * shell-surface.ts, everything under the transcript: the passive hint rows
 * (retry affordance, context pressure, the scriptable status line) when they
 * have something to say, then the composer, then the one-row status line.
 *
 * At rest that is 4 rows (composer 3 + status 1); with the header, the
 * resting chrome is 5 rows. The composer holds only input. Token totals, the
 * per-turn history, tool count, notification mode, the session spine and the
 * web surface address live in the Usage modal and /status, not on the main
 * screen. What stays always visible is safety: the approval mode and the
 * auto-approve warning, the live microphone and the sleep-disabled chip (the
 * left end of the status line), the failover marker (the header, after the
 * model) and the compaction-pressure hint (a hint row above the composer).
 */

/** The work tree's keys, shown on the status line while the keyboard is in it. */
const WORK_TREE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['↑↓', 'move between beads'], ['←→', 'fold / unfold'], ['enter', 'open'], ['y', 'copy'], ['esc', 'back to typing'],
];

/** What an agent or process view changes under the transcript. */
export interface ShellFooterView {
  /** The composer bar: the agent's lane color, or the process color. */
  readonly barColor: string;
  readonly placeholder?: string;
  /** The composer takes no input; this says why. */
  readonly disabledReason?: string;
  /** The view's keys on the status line (esc back to main, ctrl+x stop, …). */
  readonly keys: ReadonlyArray<readonly [string, string]>;
  /** After the keys: main kept in sight (◐ main · working). */
  readonly trail?: { readonly text: string; readonly fg: string } | null;
  /** A notice in place of the keys (press ctrl+x again to stop). */
  readonly notice?: { readonly text: string; readonly tone: 'error' | 'info' } | null;
  /** The process view shows no context bar or cost. */
  readonly noContext?: boolean;
  /** The cost this view states instead of the session's (an agent's own, when priced). */
  readonly cost?: string | null;
}

export interface ShellFooterBuildOptions {
  readonly width: number;
  /** The keyboard is in the conversation work tree: the status line shows its keys. */
  readonly workTreeFocused?: boolean;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number;
  readonly promptFocused?: boolean;
  readonly usage: { up: number; down: number; cacheRead?: number; cacheWrite?: number; fleetCostUsd?: number | null };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  /** The model the session cost is priced against; not drawn (the header names the model). */
  readonly model?: string;
  readonly workingDir?: string;
  /** The home directory, drawn as ~ at the start of the working directory. */
  readonly homeDirectory?: string;
  /** An agent or process view is showing (session-focus.ts). */
  readonly view?: ShellFooterView | null;
  /** The current branch (and dirty marker), shown beside the directory at rest. */
  readonly branch?: string;
  /** The model's context window; null when it is unknown (the meter says "unknown"). */
  readonly contextWindow?: number | null;
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
   * 'custom' | 'plan' | 'accept-edits'). Named by the status line's mode chip
   * and colors the composer's bar. Cycled by Shift+Tab and toggled by /plan.
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

/** The composer's bar color: the session mode, or shell while a shell command is typed. */
function composerBarColor(permissionMode: string | undefined, shell: boolean): string {
  const t = activeTokens();
  if (shell) return t.accent;
  switch (permissionMode) {
    case 'plan': return t.info;
    case 'accept-edits':
    case 'allow-all':
    case 'custom':
      return t.warning;
    default:
      return t.brand;
  }
}

/**
 * The status line's mode chip: the approval mode (muted; plan in the info
 * color), or "! auto-approve" in the error color while everything is
 * auto-approved. While the warning shows, only plan keeps its name beside it
 * (a read-only posture still worth knowing); "normal" or "auto" next to it
 * would only repeat or contradict it.
 */
function modeChips(permissionMode: string | undefined, dangerMode: boolean): StatusChip[] {
  const t = activeTokens();
  const chips: StatusChip[] = [];
  if (!dangerMode || permissionMode === 'plan') {
    chips.push({ text: permissionModeLabel(permissionMode), fg: permissionMode === 'plan' ? t.info : t.textMuted, bold: permissionMode === 'plan', keep: true });
  }
  if (dangerMode) chips.push({ text: '! auto-approve', fg: t.error, bold: true, keep: true });
  return chips;
}

/** The chips no view hides: auto-approve, the live microphone, sleep disabled. */
function safetyChips(options: ShellFooterBuildOptions): StatusChip[] {
  const t = activeTokens();
  const chips: StatusChip[] = [];
  if (options.dangerMode) chips.push({ text: '! auto-approve', fg: t.error, bold: true, keep: true });
  const voice = options.voiceCapture ?? null;
  if (voice && voiceCaptureRowVisible(voice)) chips.push(voiceCaptureChip(voice));
  if (options.powerKeepAwake) chips.push({ text: SLEEP_DISABLED_CHIP, fg: t.warning, bold: true, keep: true });
  return chips;
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

function displayDirectory(workingDir: string | undefined, homeDirectory: string | undefined): string | undefined {
  if (!workingDir) return undefined;
  const home = homeDirectory ?? (typeof process !== 'undefined' ? process.env.HOME ?? '' : '');
  if (!home) return workingDir;
  if (workingDir === home) return '~';
  return workingDir.startsWith(home.endsWith('/') ? home : `${home}/`) ? '~' + workingDir.slice(home.replace(/\/$/, '').length) : workingDir;
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
  const view = options.view ?? null;
  lines.push(...renderComposer({
    width: options.width,
    promptText: options.promptText,
    cursorPos: options.promptCursorPos,
    focused,
    unfocusedHint: 'Esc returns to the composer',
    argsHint: options.commandArgsHint,
    modeColor: view ? view.barColor : composerBarColor(options.permissionMode, options.composerPendingRisk === 'shell'),
    placeholder: view?.placeholder,
    disabledReason: view?.disabledReason,
  }));

  // The left end of the status line: mode, auto-approve, microphone and
  // sleep are kept at any width; the composer flags are dropped first.
  const chips: StatusChip[] = modeChips(options.permissionMode, options.dangerMode === true);
  const voice = options.voiceCapture ?? null;
  if (voice && voiceCaptureRowVisible(voice)) chips.push(voiceCaptureChip(voice));
  if (options.powerKeepAwake) chips.push({ text: SLEEP_DISABLED_CHIP, fg: t.warning, bold: true, keep: true });
  for (const flag of options.composerFlags ?? []) {
    if (flag === 'shell') continue; // the bar's accent color says shell
    // An orchestration request leaves this terminal: its flag carries the remote color.
    const remote = flag === 'orchestration' && options.composerPendingRisk === 'remote';
    chips.push({ text: flag, fg: remote ? activeUiTones().chrome.remote : t.textFaint, bold: remote });
  }

  const copied = Date.now() - options.lastCopyTime < 2000;
  if (view) {
    // Inside an agent or process view: its keys (what Esc does first), then main kept in sight.
    lines.push(tagFooterLine(renderStatusLine({
      width: options.width,
      chips: safetyChips(options),
      notice: options.showExitNotice ? { text: 'Press Ctrl+C again to exit', tone: 'error' } : view.notice ?? (copied ? { text: 'Copied', tone: 'info' } : null),
      keys: view.keys,
      trail: view.trail ?? null,
      cost: view.noContext ? null : view.cost ?? null,
      context: null,
    }), 'usage'));
    lastRenderedFooterHeight = lines.length;
    return { lines, height: lines.length };
  }
  // A click anywhere on the status line (the context bar, the cost) opens Usage.
  lines.push(tagFooterLine(renderStatusLine({
    width: options.width,
    chips,
    notice: options.showExitNotice
      ? { text: 'Press Ctrl+C again to exit', tone: 'error' }
      : copied ? { text: 'Copied', tone: 'info' } : null,
    // With text in the composer the next Esc clears it; only an empty composer's Esc interrupts.
    busy: options.busy ? { ...options.busy, escAction: options.promptText.trim().length > 0 ? 'clear input' : undefined } : null,
    keys: options.workTreeFocused ? WORK_TREE_KEYS : null,
    directory: displayDirectory(options.workingDir, options.homeDirectory),
    branch: options.branch,
    background: {
      agents: options.runningAgentCount,
      processes: options.runningProcessCount,
      focused: options.indicatorFocused,
      progress: options.runningAgentProgress,
    },
    cost: statusCostText(options.usage, options.model),
    // null: the model's window is unknown, and the meter says so; 0 or
    // undefined: no meter (no model yet).
    context: options.contextWindow === null || (options.contextWindow !== undefined && options.contextWindow > 0)
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
