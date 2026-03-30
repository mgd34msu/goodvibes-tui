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
 * background exec processes are running. Includes a `↓ Enter to view` hint
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

  // --- Focused state: always render before idle/active branches ---
  if (focused) {
    const parts: string[] = [];
    if (agentCount > 0) parts.push(`${agentCount} agent${agentCount !== 1 ? 's' : ''}`);
    if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''} running`);
    const focusLabel = total === 0
      ? '  \u25b6 No background processes'
      : `  \u25b6 ${parts.join(' \u00b7 ')}`;
    const focusHint = total === 0
      ? '  \u2191 back to input  '
      : '  Enter to open  \u2191 back to input  ';
    const fullText = focusLabel + ' '.repeat(Math.max(1, width - getDisplayWidth(focusLabel) - getDisplayWidth(focusHint))) + focusHint;
    const line = UIFactory.stringToLine(truncateToWidth(fullText.padEnd(width), width), width, { fg: '#00ffff', bold: true });
    return [line];
  }

  if (total === 0) {
    // Show a dimmed idle line
    const text = '  ⚡ No background processes';
    const padded = text.padEnd(width);
    return [UIFactory.stringToLine(padded, width, { fg: '238', dim: true })];
  }

  // Build the label: "⚡ 2 agents · Turn 3 · write — src/foo.ts"
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
   * Breakdown: "⚡ N agents" prefix (~15 chars) + " · " separator (~3)
   * + "  ↓ Enter to view  " hint (~19) + padding (~8) ≈ 45 chars.
   */
  const PROGRESS_RESERVED_CHARS = 45;
  const progressMaxLen = Math.max(0, width - PROGRESS_RESERVED_CHARS); // reserve space for count + hint
  const progressSuffix = agentProgress && progressMaxLen > 10
    ? ` · ${agentProgress.length > progressMaxLen ? agentProgress.slice(0, progressMaxLen - 1) + '\u2026' : agentProgress}`
    : '';
  const label = `  \u26a1 ${parts.join(' \u00b7 ')}${progressSuffix}`;

  // Right-aligned hint
  const hint = '  ↓ Enter to view  ';
  const hintW = getDisplayWidth(hint);
  const labelW = getDisplayWidth(label);
  const spacerW = Math.max(1, width - labelW - hintW);
  const fullText = label + ' '.repeat(spacerW) + hint;

  // Render the base line dim
  const line = UIFactory.stringToLine(truncateToWidth(fullText.padEnd(width), width), width, { fg: '238', dim: true });

  // Overlay label with cyan + bold
  let col = 0;
  for (const ch of label) {
    if (col >= width) break;
    const cw = getDisplayWidth(ch);
    line[col] = {
      char: ch,
      fg: '#00ffff',
      bg: '',
      bold: true,
      dim: false,
      underline: false,
      italic: false,
      strikethrough: false,
    };
    if (cw === 2 && col + 1 < width) {
      line[col + 1] = { ...line[col], char: '' };
    }
    col += cw;
  }

  // Overlay hint with yellow
  const hintStart = labelW + spacerW;
  let hintCol = hintStart;
  for (const ch of hint) {
    if (hintCol >= width) break;
    const cw = getDisplayWidth(ch);
    line[hintCol] = {
      char: ch,
      fg: '#ffcc00',
      bg: '',
      bold: false,
      dim: false,
      underline: false,
      italic: false,
      strikethrough: false,
    };
    if (cw === 2 && hintCol + 1 < width) {
      line[hintCol + 1] = { ...line[hintCol], char: '' };
    }
    hintCol += cw;
  }

  return [line];
}
