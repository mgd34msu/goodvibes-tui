import { formatDuration } from '../utils/format-duration.ts';
import { calcSessionCost } from '../export/cost-utils.ts';
import type { AgentEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';

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

// ---------------------------------------------------------------------------
// Inspector filter modes (ported from the merged agent-logs console — WO-110)
// ---------------------------------------------------------------------------

export type AgentInspectorFilterType = 'all' | 'assistant' | 'tool' | 'error';

export const AGENT_INSPECTOR_FILTER_CYCLE: readonly AgentInspectorFilterType[] = ['all', 'assistant', 'tool', 'error'];

export const AGENT_INSPECTOR_FILTER_LABELS: Record<AgentInspectorFilterType, string> = {
  all: 'All',
  assistant: 'Assistant',
  tool: 'Tool',
  error: 'Error',
};

/**
 * True when a timeline entry's kind should be visible under the given filter.
 * Mapped against the REAL row kinds jsonlToTimeline() produces (tool_call /
 * tool_result), not the legacy agent-logs-shared schema (assistant/tool_call/
 * tool_result vs. the writer-emitted tool_execution/llm_response) that never
 * matched anything.
 */
export function matchesInspectorFilter(kind: AgentInspectorEntryKind, filter: AgentInspectorFilterType): boolean {
  switch (filter) {
    case 'all': return true;
    case 'assistant': return kind === 'assistant';
    case 'tool': return kind === 'tool_call' || kind === 'tool_result';
    case 'error': return kind === 'error';
    default: return true;
  }
}

// ---------------------------------------------------------------------------
// Per-agent cost/token summary (calcSessionCost, cost-utils.ts)
// ---------------------------------------------------------------------------

export function formatAgentCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export interface AgentUsageSummary {
  readonly tokens: number;
  readonly cost: number;
}

interface AgentUsageLike {
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  } | null;
  readonly model?: string | null;
}

/**
 * Total token count + cost for an agent record's usage, or null when no usage
 * data has landed yet (honest-UX: never fabricate a $0.00/0-token reading for
 * an agent that simply hasn't reported usage).
 */
export function summarizeAgentUsage(rec: AgentUsageLike): AgentUsageSummary | null {
  if (!rec.usage) return null;
  const inputTokens = rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
  const cost = calcSessionCost(
    rec.usage.inputTokens,
    rec.usage.outputTokens,
    rec.usage.cacheReadTokens ?? 0,
    rec.usage.cacheWriteTokens ?? 0,
    rec.model ?? 'unknown',
  );
  return { tokens: inputTokens + rec.usage.outputTokens, cost };
}

// ---------------------------------------------------------------------------
// WRFC badge segments (AgentRecord.wrfcId/wrfcRole)
// ---------------------------------------------------------------------------

interface WrfcLike {
  readonly wrfcId?: string | null;
  readonly wrfcRole?: string | null;
}

/** Segments for the WRFC chain badge + token/cost line, or null when neither applies. */
export function buildWrfcCostSegments(
  rec: WrfcLike & AgentUsageLike,
  palette: { readonly label: string; readonly info: string },
  formatTokens: (n: number) => string,
): Array<[string, string]> | null {
  const segments: Array<[string, string]> = [];
  if (rec.wrfcId) {
    segments.push([' WRFC ', palette.label]);
    segments.push([`${rec.wrfcRole ?? 'agent'} · ${rec.wrfcId.slice(-8)}`, palette.info]);
  }
  const usage = summarizeAgentUsage(rec);
  if (usage) {
    segments.push([segments.length > 0 ? '   Tokens ' : ' Tokens ', palette.label]);
    segments.push([formatTokens(usage.tokens), palette.info]);
    segments.push(['   Cost ', palette.label]);
    segments.push([formatAgentCost(usage.cost), palette.info]);
  }
  return segments.length > 0 ? segments : null;
}

// ---------------------------------------------------------------------------
// Agent lifecycle event subscriptions (ported from agent-logs — WO-110)
// ---------------------------------------------------------------------------

export interface AgentActivityHooks {
  /** Any AGENT_* activity event for this agent (running/progress/stream/awaiting/finalizing/spawning). */
  readonly onActivity: (agentId: string) => void;
  /** AGENT_SPAWNING only — used for auto-select-newest-agent. */
  readonly onSpawn: (agentId: string) => void;
  /** AGENT_COMPLETED/FAILED/CANCELLED. */
  readonly onTerminal: (agentId: string) => void;
}

/** Wires the standard set of agent lifecycle listeners; returns their unsubscribe functions. */
export function subscribeAgentActivity(agentEvents: UiEventFeed<AgentEvent>, hooks: AgentActivityHooks): Array<() => void> {
  const unsubs: Array<() => void> = [];
  const activityTypes = [
    'AGENT_RUNNING', 'AGENT_PROGRESS', 'AGENT_STREAM_DELTA',
    'AGENT_AWAITING_MESSAGE', 'AGENT_AWAITING_TOOL', 'AGENT_FINALIZING',
  ] as const;
  for (const type of activityTypes) {
    unsubs.push(agentEvents.on(type, (payload: { agentId: string }) => hooks.onActivity(payload.agentId)));
  }
  unsubs.push(agentEvents.on('AGENT_SPAWNING', (payload) => {
    hooks.onActivity(payload.agentId);
    hooks.onSpawn(payload.agentId);
  }));
  unsubs.push(
    agentEvents.on('AGENT_COMPLETED', (payload) => hooks.onTerminal(payload.agentId)),
    agentEvents.on('AGENT_FAILED', (payload) => hooks.onTerminal(payload.agentId)),
    agentEvents.on('AGENT_CANCELLED', (payload) => hooks.onTerminal(payload.agentId)),
  );
  return unsubs;
}
