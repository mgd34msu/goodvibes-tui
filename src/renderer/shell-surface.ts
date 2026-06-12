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
}

export interface ShellFooterBuildResult {
  readonly lines: Line[];
  readonly height: number;
}

const FOOTER_BASE_ROWS = 9;
const CONTEXT_PROGRESS_ROWS = 2;
const PROCESS_INDICATOR_ROWS = 1;

export function estimateShellFooterHeight(
  promptLineCount: number,
  contextWindow?: number,
): number {
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
  );
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
  return { lines, height: lines.length };
}
