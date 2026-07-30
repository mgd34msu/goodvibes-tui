import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { GLYPHS, UI_TONES } from './ui-primitives.ts';
import { activeUiTones } from './theme.ts';
import { formatHints } from './hint-grammar.ts';
import { voiceCaptureRowVisible, type VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';

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
 * opens the fleet for the full picture. (item 5d.)
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

/**
 * Sentence each capture state renders as. Written out per state rather than
 * assembled from fragments because these are the words that tell a user whether
 * their microphone is open — "listening" and "recording" mean different things
 * and a row that blurred them would be worse than no row.
 */
const VOICE_CAPTURE_LABELS: Record<VoiceCaptureIndicatorState['kind'], string> = {
  requesting: 'opening the microphone',
  recording: 'recording — press the voice-input key again to stop',
  transcribing: 'transcribing what you said',
  'wake-listening': 'listening for the wake phrase',
  'wake-capturing': 'wake heard — recording what follows',
  'wake-restarting': 'capture stream ended — restarting',
  'wake-latched': 'wake detection stopped',
};

/**
 * renderVoiceCaptureIndicator — the persistent row shown while a microphone is
 * open, below the input area beside the process indicator.
 *
 * It exists because a held-open capture device is otherwise invisible: wake
 * detection runs for as long as the feature is on, and nothing else on screen
 * would say so. `voice.wake.indicator` chooses between `statusline` (one dim
 * row), `banner` (a highlighted row that is hard to miss) and `off`; a
 * push-to-talk recording always renders, because the user pressed a key one
 * moment ago and is waiting on it.
 *
 * Returns no lines when nothing is captured, or when the wake rows are turned
 * off — the caller splices whatever comes back, so an empty array is "no row".
 */
export function renderVoiceCaptureIndicator(
  width: number,
  state: VoiceCaptureIndicatorState | null,
): Line[] {
  if (!voiceCaptureRowVisible(state) || state === null) return [];
  const tones = activeUiTones();
  const marker = state.kind === 'wake-latched' ? GLYPHS.status.blocked : GLYPHS.status.active;
  const device = state.deviceLabel !== null ? ` ${GLYPHS.navigation.pipeSeparator} ${state.deviceLabel}` : '';
  const extra = state.detail !== undefined && state.detail.length > 0
    ? ` ${GLYPHS.navigation.pipeSeparator} ${state.detail}`
    : '';
  const body = `${marker} Voice: ${VOICE_CAPTURE_LABELS[state.kind]}${device}${extra}`;
  const isWakeRow = state.kind.startsWith('wake-');
  const fg = state.kind === 'wake-latched' || state.kind === 'wake-restarting'
    ? tones.chrome.warn
    : tones.accent.control;

  if (isWakeRow && state.indicator === 'banner') {
    // The prominent variant: the row is filled to the terminal width on the
    // footer background so it reads as a standing condition, not a passing note.
    const line = UIFactory.stringToLine(' '.repeat(width), width, { fg: tones.chrome.faint });
    const text = ` ${truncateDisplay(body, Math.max(0, width - 4), '…')} `;
    for (let i = 0; i < text.length && 1 + i < width - 1; i++) {
      const cell = line[1 + i]!;
      cell.char = text[i]!;
      cell.fg = fg;
      cell.bg = tones.bg.footer;
      cell.bold = true;
      cell.dim = false;
    }
    return [line];
  }
  return [UIFactory.stringToLine(`   ${truncateDisplay(body, Math.max(0, width - 4), '…')}`, width, { fg, bold: true })];
}
