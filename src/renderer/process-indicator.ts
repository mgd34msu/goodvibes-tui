import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { GLYPHS, UI_TONES } from './ui-primitives.ts';
import { activeUiTones } from './theme.ts';
import { formatHints } from './hint-grammar.ts';

/**
 * renderProcessIndicator — shows a one-line summary of active background
 * processes below the input area.
 *
 * Dimmed when no processes are active, highlighted (cyan) when agents or
 * background exec processes are running. Includes an `[Enter] View` hint
 * (hint-grammar bracket form) when active.
 */
/**
 * Agent-count label. The footer counts only ACTIVE agents, while the fleet
 * lists every node (running, terminal, chains, watchers). Label the count
 * "active" so it is never misread as a grand total — the [Enter] View hint
 * opens the fleet for the full picture. (UX-B item 5d.)
 */
function agentCountLabel(agentCount: number): string {
  return `${agentCount} agent${agentCount !== 1 ? 's' : ''} active`;
}

export function renderProcessIndicator(
  width: number,
  agentCount: number,
  toolCount: number,
  focused: boolean = false,
  agentProgress?: string,
): Line[] {
  const total = agentCount + toolCount;
  const renderPlainStatus = (text: string, style: { fg: string; bold?: boolean; dim?: boolean }): Line[] => (
    [UIFactory.stringToLine(`   ${text}`, width, style)]
  );
  const renderFocusedStatus = (text: string): Line[] => {
    const bg = '#31506f';
    const fg = '#eefaff';
    const markerFg = UI_TONES.accent.browser;
    const line = UIFactory.stringToLine(' '.repeat(width), width, { fg: '238' });
    const prefix = `${GLYPHS.navigation.selected} `;
    const body = truncateDisplay(text, Math.max(0, width - 8), '');
    const highlighted = ` ${prefix}${body} `;
    const startX = 2;
    for (let i = 0; i < highlighted.length && startX + i < width - 2; i++) {
      const ch = highlighted[i]!;
      const isMarker = i < prefix.length + 1;
      line[startX + i].char = ch;
      line[startX + i].fg = isMarker ? markerFg : fg;
      line[startX + i].bg = bg;
      line[startX + i].bold = true;
      line[startX + i].dim = false;
    }
    return [line];
  };

  // --- Focused state: always render before idle/active branches ---
  if (focused) {
    const parts: string[] = [];
    if (agentCount > 0) parts.push(agentCountLabel(agentCount));
    if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''} running`);
    const label = total === 0
      ? `No background processes  ${formatHints([{ key: 'Esc', verb: 'Back to input' }])}`
      : `${parts.join(` ${GLYPHS.navigation.pipeSeparator} `)}  ${formatHints([{ key: 'Enter', verb: 'Open' }, { key: 'Esc', verb: 'Back to input' }])}`;
    return renderFocusedStatus(label);
  }

  if (total === 0) {
    return renderPlainStatus('No background processes', { fg: '238', dim: true });
  }

  // Build the label: "bg: 2 agents | Turn 3 | write - src/foo.ts"
  const parts: string[] = [];
  if (agentCount > 0) {
    parts.push(agentCountLabel(agentCount));
  }
  if (toolCount > 0) {
    parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''} running`);
  }
  // Append the first running agent's progress (truncated to fit)
  /**
   * Number of columns reserved for the agent count label and hint text.
   * Breakdown: "bg: N agents" prefix (~15 chars) + " | " separator (~3)
   * + "  [Enter] View  " hint (~16) + padding (~9) ≈ 43 chars.
   */
  const PROGRESS_RESERVED_CHARS = 43;
  const progressMaxLen = Math.max(0, width - PROGRESS_RESERVED_CHARS); // reserve space for count + hint
  // Truncate by display width (not JS string length) so wide/CJK glyphs in the
  // agent progress text don't overflow the reserved budget.
  const progressSuffix = agentProgress && progressMaxLen > 10
    ? ` | ${truncateDisplay(agentProgress, progressMaxLen, '...')}`
    : '';
  const label = `${parts.join(` ${GLYPHS.navigation.pipeSeparator} `)}${progressSuffix}`;
  const hint = `  ${formatHints([{ key: 'Enter', verb: 'View' }])}`;
  return renderPlainStatus(`${label}${hint}`, { fg: activeUiTones().accent.brand, bold: true });
}
