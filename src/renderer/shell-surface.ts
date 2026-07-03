import type { Line } from '../types/grid.ts';
import { renderProcessIndicator } from './process-indicator.ts';
import { UIFactory } from './ui-factory.ts';

export interface ShellFooterBuildOptions {
  readonly width: number;
  readonly promptText: string;
  readonly promptLineCount: number;
  readonly promptCursorPos?: number;
  readonly promptFocused?: boolean;
  readonly usage: { up: number; down: number };
  readonly showExitNotice: boolean;
  readonly lastCopyTime: number;
  readonly model?: string;
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
   * Passive context pressure hint from buildContextStatusHint.
   * Rendered as a dim informational line above the prompt when non-null.
   */
  readonly contextStatusHint?: string | null;
  /**
   * Compact footer posture for short terminals (~<30 rows). Collapses the
   * footer to its essentials (prompt box + token/cost line + help) and drops
   * the process indicator, context bar, context-info line and posture block.
   */
  readonly compact?: boolean;
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

/**
 * Real height of the most recently rendered footer. estimateShellFooterHeight
 * prefers this so the pre-prompt viewport math accounts for the composer
 * posture block and context hint that the static formula cannot see. Reset to
 * null before any footer has rendered (cold start), where the formula is exact
 * for the common posture-free, hint-free case.
 */
let lastRenderedFooterHeight: number | null = null;

export function estimateShellFooterHeight(
  promptLineCount: number,
  contextWindow?: number,
): number {
  if (lastRenderedFooterHeight !== null) return lastRenderedFooterHeight;
  const safePromptLines = Math.max(1, promptLineCount);
  const progressRows = contextWindow && contextWindow > 0 ? CONTEXT_PROGRESS_ROWS : 0;
  return FOOTER_BASE_ROWS + safePromptLines + progressRows + PROCESS_INDICATOR_ROWS;
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
    options.promptFocused ?? !options.indicatorFocused,
    options.composerMode,
    options.composerStatus,
    options.composerFlags,
    options.composerPendingRisk,
    options.compact ?? false,
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
    lines.splice(inputBoxRows, 0, ...processIndicator);
    // Passive context status hint — rendered as a dim informational line before the prompt.
    if (options.contextStatusHint) {
      const hintLine = UIFactory.stringToLine(options.contextStatusHint, options.width, { fg: '#64748b' });
      lines.unshift(hintLine);
    }
  }
  lastRenderedFooterHeight = lines.length;
  return { lines, height: lines.length };
}
