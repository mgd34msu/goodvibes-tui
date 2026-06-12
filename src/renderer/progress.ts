import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth, padDisplayEnd } from '../utils/terminal-width.ts';

// Rich spinner frames (used by progress indicators)
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Braille thinking spinner frames (used by the orchestrator thinking animation)
export const THINKING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * renderSpinner - Render a spinner with label as a single Line.
 */
export function renderSpinner(
  frame: string,
  label: string,
  width: number,
  fg: string = '135'
): Line {
  const text = ` ${frame} ${label}`;
  return UIFactory.stringToLine(padDisplayEnd(text, width), width, { fg, bold: true });
}

/**
 * renderToolProgress - Render tool execution progress.
 * E.g. "[2/5] Editing src/config.ts..."
 */
export function renderToolProgress(
  current: number,
  total: number,
  label: string,
  width: number
): Line[] {
  const counter = `[${current}/${total}]`;
  const text = ` ${counter} ${label}`;
  return [
    UIFactory.stringToLine(padDisplayEnd(text, width), width, { fg: '#ffcc00', bold: true }),
  ];
}

/**
 * renderTokenBar - Render a token usage bar for the footer.
 * Shows used/max tokens as a visual bar + numbers.
 */
export function renderTokenBar(
  used: number,
  max: number,
  width: number,
  model: string,
  toolCount: number
): Line[] {
  const lines: Line[] = [];

  // Stats row
  const usedK = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : String(used);
  const maxK = max >= 1000 ? `${(max / 1000).toFixed(1)}k` : String(max);
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const toolStr = toolCount > 0 ? `  tools:${toolCount}` : '';
  const statsText = ` ${model}  in:${usedK}/${maxK} (${pct}%)${toolStr}`;

  // Progress bar
  const barLabel = ' ctx ';
  const barLabelW = getDisplayWidth(barLabel);
  const barW = Math.max(10, Math.floor(width * 0.3));
  const filled = Math.round((pct / 100) * barW);
  const empty = barW - filled;

  // Color based on usage
  const barFg = pct > 85 ? '#ef4444' : pct > 60 ? '#ffcc00' : '#22c55e';

  const bar = '#'.repeat(filled) + '-'.repeat(empty);
  const barText = barLabel + bar;

  const statsW = getDisplayWidth(statsText);
  const barTextW = getDisplayWidth(barText);
  const spacingW = Math.max(1, width - statsW - barTextW - 2);

  // Build with mixed colors
  const line = UIFactory.stringToLine(statsText + ' '.repeat(spacingW), width, { fg: '244', dim: true });

  // Overlay the bar with color
  let barStartX = getDisplayWidth(statsText) + spacingW;
  for (const ch of barLabel) {
    if (barStartX >= width) break;
    const cw = getDisplayWidth(ch);
    line[barStartX] = { char: ch, fg: '244', bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false };
    if (cw === 2 && barStartX + 1 < width) line[barStartX + 1] = { ...line[barStartX], char: '' };
    barStartX += cw;
  }
  for (let i = 0; i < filled && barStartX + i < width; i++) {
    line[barStartX + i] = { char: '#', fg: barFg, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  }
  for (let i = 0; i < empty && barStartX + filled + i < width; i++) {
    line[barStartX + filled + i] = { char: '-', fg: '238', bg: '', bold: false, dim: true, underline: false, italic: false, strikethrough: false };
  }

  lines.push(line);
  return lines;
}
