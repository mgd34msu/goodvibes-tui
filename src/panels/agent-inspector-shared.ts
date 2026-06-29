import { formatDuration } from '../utils/format-duration.ts';

export type AgentInspectorEntryKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'session' | 'error';

// ---------------------------------------------------------------------------
// Shared agent status / stall constants
// Used by AgentInspectorPanel, AgentDetailModal, and cockpit read-model consumers.
// ---------------------------------------------------------------------------

/** Terminal statuses — cancel not offered; stall check skipped. */
export const AGENT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Agents in a non-terminal state for longer than this are considered STALLED. */
export const AGENT_STALL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Count stalled agents from a raw record list.
 * An agent is stalled when it is non-terminal and has been running for at
 * least AGENT_STALL_THRESHOLD_MS without completing.
 *
 * Extracted as a standalone export so read-models and panels can share the
 * canonical stall-count logic (TASK-046).
 */
export function countStalledAgents(
  records: ReadonlyArray<{ status: string; startedAt: number }>,
  now: number = Date.now(),
): number {
  return records.filter(
    (r) => !AGENT_TERMINAL_STATUSES.has(r.status) && (now - r.startedAt) >= AGENT_STALL_THRESHOLD_MS,
  ).length;
}


export interface AgentTimelineEntry {
  kind: AgentInspectorEntryKind;
  timestamp: number;
  label: string;
  content: string;
  detail?: string;
  expanded: boolean;
}

export interface AgentDisplayRow {
  kind: AgentInspectorEntryKind;
  timestamp: number;
  content: string;
  hasDetail: boolean;
  expanded: boolean;
  entryRef: AgentTimelineEntry | null;
}

type JsonlRow = Record<string, unknown>;

export function agentStatusColor(status: string, colors: Record<string, string>): string {
  switch (status) {
    case 'pending': return colors.pending ?? colors.system;
    case 'running': return colors.running ?? colors.system;
    case 'completed': return colors.completed ?? colors.system;
    case 'failed': return colors.failed ?? colors.system;
    case 'cancelled': return colors.cancelled ?? colors.system;
    default: return colors.system;
  }
}

export function formatAgentDuration(ms: number): string {
  return formatDuration(ms);
}

export function formatAgentTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function jsonlToTimeline(rows: JsonlRow[]): AgentTimelineEntry[] {
  const entries: AgentTimelineEntry[] = [];
  for (const row of rows) {
    const type = String(row.type ?? 'unknown');
    const rawTs = row.timestamp;
    const ts = typeof rawTs === 'string' ? Date.parse(rawTs) : typeof rawTs === 'number' ? rawTs : Date.now();
    switch (type) {
      case 'tool_execution': {
        const toolName = String(row.toolName ?? 'tool');
        const argsStr = row.args !== undefined ? JSON.stringify(row.args, null, 2) : undefined;
        const resultStr = row.result !== undefined ? JSON.stringify(row.result, null, 2) : undefined;
        const detail = [argsStr ? `Args:\n${argsStr}` : '', resultStr ? `Result:\n${resultStr}` : ''].filter(Boolean).join('\n\n');
        entries.push({ kind: 'tool_call', timestamp: ts, label: toolName, content: `[tool] ${toolName}` + (row.durationMs !== undefined ? ` (${row.durationMs}ms)` : ''), detail: detail || undefined, expanded: false });
        break;
      }
      case 'llm_response': {
        const toolCount = Number(row.toolCallCount ?? 0);
        const charLen = Number(row.contentLength ?? 0);
        entries.push({ kind: 'assistant', timestamp: ts, label: 'assistant', content: `[assistant] ${charLen} chars, ${toolCount} tool calls`, expanded: false });
        break;
      }
      case 'meta':
      case 'session_start':
        entries.push({ kind: 'session', timestamp: ts, label: 'session', content: `[session start] ${String(row.agentId ?? '')}`, expanded: false });
        break;
      case 'session_end':
        entries.push({ kind: 'session', timestamp: ts, label: 'session', content: `[session end] ${String(row.status ?? 'unknown')}`, expanded: false });
        break;
      case 'error':
        entries.push({ kind: 'error', timestamp: ts, label: 'error', content: `[error] ${String(row.message ?? row.error ?? 'unknown error')}`, expanded: false });
        break;
      default:
        entries.push({ kind: 'session', timestamp: ts, label: type, content: `[${type}]`, expanded: false });
        break;
    }
  }
  return entries;
}

export function agentKindStyle(kind: AgentInspectorEntryKind, colors: Record<string, string>): { fg: string; prefix: string } {
  switch (kind) {
    case 'user': return { fg: colors.user, prefix: '[user]     ' };
    case 'assistant': return { fg: colors.assistant, prefix: '[assistant]' };
    case 'tool_call': return { fg: colors.tool, prefix: '[tool]     ' };
    case 'tool_result': return { fg: colors.toolResult, prefix: '  \u2514     ' };
    case 'session': return { fg: colors.system, prefix: '[session]  ' };
    case 'error': return { fg: colors.error, prefix: '[error]    ' };
    default: return { fg: colors.dimmed ?? colors.system, prefix: '[?]        ' };
  }
}
