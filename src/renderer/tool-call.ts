import { type Line } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { renderMarkdown } from './markdown.ts';
import { renderDiffView } from './diff-view.ts';
import { renderCodeBlock } from './code-block.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';

type ToolStatus = 'pending' | 'running' | 'done' | 'failed';

/** Icon map by tool name. */
const TOOL_ICONS: Record<string, string> = {
  'file-read': '📖',
  'file-write': '✏️',
  'file-edit': '📝',
  'shell-exec': '⚡',
  'grep': '🔍',
  'list-dir': '📁',
  'glob': '🔎',
};

/** Status badge styles. */
const STATUS_STYLES: Record<ToolStatus, { label: string; fg: string; bold: boolean }> = {
  pending: { label: 'PENDING', fg: '244',     bold: false },
  running: { label: 'RUNNING', fg: '#ffcc00', bold: true  },
  done:    { label: 'DONE',    fg: '#22c55e', bold: true  },
  failed:  { label: 'FAILED',  fg: '#ef4444', bold: true  },
};

/**
 * getToolTitle - Derive a human-readable title from a tool call.
 * E.g. file-read + { path: 'src/main.ts' } => "Reading src/main.ts"
 */
function getToolTitle(name: string, args: Record<string, unknown>): string {
  const verbs: Record<string, string> = {
    'file-read':  'Reading',
    'file-write': 'Writing',
    'file-edit':  'Editing',
    'shell-exec': 'Running',
    'grep':       'Searching',
    'list-dir':   'Listing',
    'glob':       'Globbing',
  };
  const verb = verbs[name] || name;
  const key = (args.path ?? args.command ?? args.pattern ?? args.directory ?? '') as string;
  return key ? `${verb} ${String(key)}` : verb;
}

/**
 * renderToolCallBlock - Render a tool call (with optional result) as Line[].
 * Compact header + optional result expansion.
 */
export function renderToolCallBlock(
  toolCall: ToolCall,
  status: ToolStatus,
  result?: ToolResult,
  width: number = 80
): Line[] {
  const lines: Line[] = [];
  const icon = TOOL_ICONS[toolCall.name] || '🔧';
  const title = getToolTitle(toolCall.name, toolCall.arguments);
  const { label: statusLabel, fg: statusFg, bold: statusBold } = STATUS_STYLES[status];

  // Header line: icon + title + [STATUS]
  const badgeText = `[${statusLabel}]`;
  const badgeW = getDisplayWidth(badgeText);
  const headerPrefix = ` ${icon} ${title}`;
  const maxTitleW = width - badgeW - 2;
  const truncatedHeader = getDisplayWidth(headerPrefix) > maxTitleW
    ? headerPrefix.slice(0, maxTitleW - 1) + '…'
    : headerPrefix;

  const paddingW = width - getDisplayWidth(truncatedHeader) - badgeW;
  const headerText = truncatedHeader + ' '.repeat(Math.max(0, paddingW)) + badgeText;

  lines.push(UIFactory.stringToLine(headerText, width, { fg: statusFg, bold: statusBold, bg: '#141414' }));

  // Result rendering (collapsed if large, expanded for diffs/code)
  if (result) {
    if (!result.success) {
      const errText = result.error || 'Unknown error';
      lines.push(UIFactory.stringToLine(`  ⚠ ${errText}`, width, { fg: '#ef4444', dim: true }));
    } else if (result.output) {
      const output = result.output;

      // Detect diff output
      if (output.includes('--- ') && output.includes('+++ ') && output.includes('@@')) {
        lines.push(...renderDiffView(output, width));
      }
      // Detect code output (from shell-exec, etc.)
      else if (toolCall.name === 'shell-exec' && output.split('\n').length > 1) {
        lines.push(...renderCodeBlock(output.split('\n'), 'bash', width));
      }
      // Short output: show inline
      else if (output.length <= 200) {
        lines.push(UIFactory.stringToLine(`  ${output}`, width, { fg: '244', dim: true }));
      }
      // Long output: truncate with count
      else {
        const preview = output.slice(0, 120).replace(/\n/g, ' ');
        const lc = output.split('\n').length;
        lines.push(UIFactory.stringToLine(`  ${preview}… (${lc} lines)`, width, { fg: '240', dim: true }));
      }
    }
  }

  return lines;
}

/**
 * renderToolCallList - Render a list of tool calls with their statuses.
 */
export function renderToolCallList(
  toolCalls: ToolCall[],
  results: Map<string, ToolResult>,
  statusMap: Map<string, ToolStatus>,
  width: number
): Line[] {
  const lines: Line[] = [];
  for (const tc of toolCalls) {
    const status = statusMap.get(tc.id) || 'pending';
    const result = results.get(tc.id);
    lines.push(...renderToolCallBlock(tc, status, result, width));
  }
  return lines;
}
