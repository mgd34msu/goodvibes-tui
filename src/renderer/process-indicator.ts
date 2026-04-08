import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

/** Truncate a string to fit within maxWidth display columns. */
function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  for (const char of text) {
    const cw = getDisplayWidth(char);
    if (width + cw > maxWidth) break;
    width += cw;
    i += char.length;
  }
  return text.slice(0, i);
}

/**
 * renderProcessIndicator — shows a one-line summary of active background
 * processes below the input area.
 *
 * Dimmed when no processes are active, highlighted (cyan) when agents or
 * background exec processes are running. Includes an `Enter to view` hint
 * when active.
 */
export function renderProcessIndicator(
  width: number,
  agentCount: number,
  toolCount: number,
  focused: boolean = false,
  agentProgress?: string,
): Line[] {
  const total = agentCount + toolCount;
  const renderPlainStatus = (text: string, style: { fg: string; bold?: boolean; dim?: boolean }): Line[] => (
    [UIFactory.stringToLine(` ${text}`, width, style)]
  );

  // --- Focused state: always render before idle/active branches ---
  if (focused) {
    const parts: string[] = [];
    if (agentCount > 0) parts.push(`${agentCount} agent${agentCount !== 1 ? 's' : ''}`);
    if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''} running`);
    const label = total === 0
      ? 'No background processes  •  back to input'
      : `${parts.join(' │ ')}  •  Enter to open  •  back to input`;
    return renderPlainStatus(label, { fg: '#00ffff', bold: true });
  }

  if (total === 0) {
    return renderPlainStatus('No background processes', { fg: '238', dim: true });
  }

  // Build the label: "bg: 2 agents | Turn 3 | write - src/foo.ts"
  const parts: string[] = [];
  if (agentCount > 0) {
    parts.push(`${agentCount} agent${agentCount !== 1 ? 's' : ''}`);
  }
  if (toolCount > 0) {
    parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''} running`);
  }
  // Append the first running agent's progress (truncated to fit)
  /**
   * Number of columns reserved for the agent count label and hint text.
   * Breakdown: "bg: N agents" prefix (~15 chars) + " | " separator (~3)
   * + "  Enter to view  " hint (~17) + padding (~8) ≈ 43 chars.
   */
  const PROGRESS_RESERVED_CHARS = 43;
  const progressMaxLen = Math.max(0, width - PROGRESS_RESERVED_CHARS); // reserve space for count + hint
  const progressSuffix = agentProgress && progressMaxLen > 10
    ? ` | ${agentProgress.length > progressMaxLen ? agentProgress.slice(0, Math.max(0, progressMaxLen - 3)) + '...' : agentProgress}`
    : '';
  const label = `${parts.join(' │ ')}${progressSuffix}`;
  const hint = '  •  Enter to view';
  return renderPlainStatus(`${label}${hint}`, { fg: '#00ffff', bold: true });
}
