import { type Line, createStyledCell, createEmptyLine } from '../types/grid.ts';
import { LAYOUT, TOOL_STATUS } from './layout.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { ToolCall } from '../types/tools.ts';
import { renderConversationKeyValueRow } from './conversation-surface.ts';

const KEY_ARG_RIGHT_RESERVE = 20;
const SUMMARY_RIGHT_RESERVE = 8;

/**
 * Extract the most meaningful argument from a tool call for display.
 */
function extractKeyArg(toolCall: ToolCall): string {
  const args = toolCall.arguments;
  // Path-based tools
  if (typeof args.path === 'string') return args.path;
  if (typeof args.file === 'string') return args.file;
  // Array-based (read/write)
  if (Array.isArray(args.files) && args.files.length > 0) {
    const first = args.files[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).path === 'string')
      return (first as Record<string, unknown>).path as string;
  }
  // Exec
  if (typeof args.command === 'string') return args.command;
  if (Array.isArray(args.commands) && args.commands.length > 0) {
    const first = args.commands[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).cmd === 'string')
      return (first as Record<string, unknown>).cmd as string;
  }
  // Find/grep
  if (typeof args.pattern === 'string') return args.pattern;
  if (Array.isArray(args.queries) && args.queries.length > 0) {
    const first = args.queries[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).pattern === 'string')
      return (first as Record<string, unknown>).pattern as string;
  }
  // Fetch
  if (Array.isArray(args.urls) && args.urls.length > 0) {
    const first = args.urls[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).url === 'string')
      return (first as Record<string, unknown>).url as string;
  }
  // Agent
  if (typeof args.task === 'string') return args.task.slice(0, 40);
  if (typeof args.mode === 'string') return args.mode;
  // Fallback: first string value
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0) return val.slice(0, 40);
  }
  return '';
}

/**
 * Render a tool call as a single collapsed line.
 *
 * Layout: [margin] [icon] [space] [tool name padded] [key arg] [summary] [duration]
 *
 * @param toolCall - The tool call being executed
 * @param status - 'executing' | 'done' | 'error'
 * @param resultSummary - Optional brief summary (e.g., "3 files", "exit 0")
 * @param width - Terminal width
 * @param durationMs - Optional duration in milliseconds
 * @param errorMsg - Optional error message for failed calls
 */
export function renderToolCallBlock(
  toolCall: ToolCall,
  status: 'executing' | 'done' | 'error',
  resultSummary: string | undefined,
  width: number,
  durationMs?: number,
  errorMsg?: string,
  frameIndex?: number,
): Line[] {
  const line = createEmptyLine(width);
  const margin = LAYOUT.LEFT_MARGIN;
  const rightMargin = LAYOUT.RIGHT_MARGIN;

  let col = margin;

  // Status icon
  const icon = status === 'done' ? TOOL_STATUS.SUCCESS_ICON
    : status === 'error' ? TOOL_STATUS.FAIL_ICON
    : TOOL_STATUS.SPINNER_FRAMES[(frameIndex ?? 0) % TOOL_STATUS.SPINNER_FRAMES.length];
  const iconColor = status === 'done' ? '#22c55e'
    : status === 'error' ? '#ef4444'
    : '244';

  if (col < width - rightMargin) {
    line[col] = createStyledCell(icon, { fg: iconColor, bold: status !== 'executing' });
  }
  col += 2; // icon + space

  // Tool name (padded to TOOL_NAME_PAD) — extract short name for long MCP tool names
  const rawName = toolCall.name.includes('__')
    ? toolCall.name.split('__').pop()!
    : toolCall.name;
  const toolName = rawName.slice(0, TOOL_STATUS.TOOL_NAME_PAD).padEnd(TOOL_STATUS.TOOL_NAME_PAD);
  for (const ch of toolName) {
    if (col >= width - rightMargin) break;
    line[col] = createStyledCell(ch, { fg: '#00ffcc', bold: true });
    col++;
  }

  // Key argument — leave room for summary + duration on the right
  const keyArg = extractKeyArg(toolCall);
  if (keyArg) {
    for (const ch of keyArg) {
      if (col >= width - rightMargin - KEY_ARG_RIGHT_RESERVE) break;
      line[col] = createStyledCell(ch, { fg: '252' });
      col++;
    }
  }

  // Error message (for failed calls)
  if (status === 'error' && errorMsg) {
    const errText = ' - ' + errorMsg.slice(0, 40);
    for (const ch of errText) {
      if (col >= width - rightMargin) break;
      line[col] = createStyledCell(ch, { fg: '#ef4444', dim: true });
      col++;
    }
  }

  // Result summary in parens (for completed calls)
  if (status === 'done' && resultSummary) {
    const summaryText = '  (' + resultSummary + ')';
    for (const ch of summaryText) {
      if (col >= width - rightMargin - SUMMARY_RIGHT_RESERVE) break;
      line[col] = createStyledCell(ch, { fg: '244', dim: true });
      col++;
    }
  }

  // Duration right-aligned
  if (durationMs !== undefined && status === 'done') {
    const durText = durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;
    const durW = getDisplayWidth(durText);
    const durStartCol = width - rightMargin - durW;
    let durCol = Math.max(col + 1, durStartCol);
    for (const ch of durText) {
      if (durCol >= width - rightMargin) break;
      line[durCol] = createStyledCell(ch, { fg: '238', dim: true });
      durCol++;
    }
  } else if (status === 'executing') {
    const dots = '...';
    const dotsStartCol = width - rightMargin - 3;
    let dotsCol = Math.max(col + 1, dotsStartCol);
    for (const ch of dots) {
      if (dotsCol >= width - rightMargin) break;
      line[dotsCol] = createStyledCell(ch, { fg: '238', dim: true });
      dotsCol++;
    }
  }

  // Normalize the base row through the shared conversation row contract.
  const rightText = (() => {
    if (durationMs !== undefined && status === 'done') {
      return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
    }
    return status === 'executing' ? '...' : '';
  })();
  const leftText = line.map((cell) => cell.char).join('').trim();
  const normalized = renderConversationKeyValueRow(width, leftText, rightText, {
    leftFg: '#e2e8f0',
    rightFg: '238',
  });
  // Re-apply rich cell styling from the original row where present.
  for (let i = 0; i < width; i++) {
    if (line[i].char !== ' ') normalized[i] = line[i];
  }

  return [normalized];
}

/**
 * Render a list of tool calls. All calls are treated as completed (done).
 * Used for historical message rendering where status/timing is unavailable.
 */
export function renderToolCallList(
  toolCalls: ToolCall[],
  width: number,
): Line[] {
  const lines: Line[] = [];
  for (const tc of toolCalls) {
    lines.push(...renderToolCallBlock(tc, 'done', undefined, width));
  }
  return lines;
}
