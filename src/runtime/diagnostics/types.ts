/**
 * Diagnostics system types — shared across all diagnostic panel data providers.
 *
 * These types are purely data-oriented. No UI rendering logic lives here.
 * All entries are immutable snapshots produced at the time of capture.
 */
import type { HealthStatus, HealthDomain, DomainHealth } from '../health/types.ts';

// ── Buffer defaults ───────────────────────────────────────────────────────────

/** Default maximum number of entries retained in a bounded diagnostic buffer. */
export const DEFAULT_BUFFER_LIMIT = 500;

// ── Filter ───────────────────────────────────────────────────────────────────

/**
 * Filter applied to diagnostic entry queries.
 * All fields are optional; omitting a field means "do not filter on this dimension".
 */
export interface DiagnosticFilter {
  /** Restrict to entries whose domain matches one of these values. */
  readonly domains?: readonly string[];
  /** Restrict to entries at or above this severity level. */
  readonly level?: DiagnosticLevel;
  /** Restrict to entries at or after this epoch ms timestamp (inclusive). */
  readonly since?: number;
  /** Restrict to entries at or before this epoch ms timestamp (inclusive). */
  readonly until?: number;
  /** Restrict to entries whose traceId matches. */
  readonly traceId?: string;
  /** Restrict to entries whose sessionId matches. */
  readonly sessionId?: string;
  /** Restrict to entries whose turnId matches. */
  readonly turnId?: string;
  /** Restrict to entries whose taskId matches. */
  readonly taskId?: string;
  /** Maximum number of entries to return (most recent first). */
  readonly limit?: number;
}

/** Severity level for diagnostic entries. */
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

// ── Tool Call entries ─────────────────────────────────────────────────────────

/** Phase of a single tool call in its execution timeline. */
export type ToolCallPhase =
  | 'received'
  | 'validated'
  | 'prehooked'
  | 'permissioned'
  | 'executing'
  | 'mapped'
  | 'posthooked'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Permission outcome attached to a tool call. */
export interface ToolCallPermission {
  /** Whether the permission check approved the call. */
  approved: boolean;
}

/**
 * Immutable diagnostic entry for a single tool call.
 * Aggregates all lifecycle phases into a single record.
 */
export interface ToolCallEntry {
  /** Unique call identifier from the event payload. */
  readonly callId: string;
  /** Turn this tool call belongs to. */
  readonly turnId: string;
  /** Tool name. */
  readonly tool: string;
  /** Arguments passed to the tool (captured at TOOL_RECEIVED). */
  readonly args: Record<string, unknown>;
  /** Current phase in the tool call lifecycle. */
  readonly phase: ToolCallPhase;
  /** Epoch ms when the call was first observed (TOOL_RECEIVED). */
  readonly receivedAt: number;
  /** Epoch ms when the call completed (succeeded/failed/cancelled). */
  readonly completedAt?: number;
  /** Duration in ms (populated on terminal phases). */
  readonly durationMs?: number;
  /** Error message (populated when phase === 'failed'). */
  readonly error?: string;
  /** Cancellation reason (populated when phase === 'cancelled'). */
  readonly cancelReason?: string;
  /** Permission result (populated when permission check completes). */
  readonly permission?: ToolCallPermission;
  /** Trace identifier from the originating envelope. */
  readonly traceId: string;
  /** Session identifier from the originating envelope. */
  readonly sessionId: string;
}

// ── Agent entries ─────────────────────────────────────────────────────────────

/** Current state of an agent in the diagnostic view. */
export type AgentDiagnosticState =
  | 'spawning'
  | 'running'
  | 'awaiting_message'
  | 'awaiting_tool'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Immutable diagnostic entry for a single agent instance.
 */
export interface AgentEntry {
  /** Unique agent identifier. */
  readonly agentId: string;
  /** Associated task identifier (if any). */
  readonly taskId?: string;
  /** Brief task description (captured at AGENT_SPAWNING). */
  readonly task: string;
  /** Current agent state. */
  readonly state: AgentDiagnosticState;
  /** Epoch ms when the agent was first observed (AGENT_SPAWNING). */
  readonly spawnedAt: number;
  /** Epoch ms when the agent reached a terminal state. */
  readonly completedAt?: number;
  /** Duration in ms (populated on terminal states). */
  readonly durationMs?: number;
  /** Error message (populated when state === 'failed'). */
  readonly error?: string;
  /** Tool call that is currently blocking this agent (AGENT_AWAITING_TOOL). */
  readonly blockedOnCallId?: string;
  /** Tool name the agent is blocked on. */
  readonly blockedOnTool?: string;
  /** Trace identifier from the originating envelope. */
  readonly traceId: string;
  /** Session identifier from the originating envelope. */
  readonly sessionId: string;
}

// ── Task entries ──────────────────────────────────────────────────────────────

/**
 * Immutable diagnostic entry for a runtime task.
 */
export interface TaskEntry {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Owning agent identifier (if any). */
  readonly agentId?: string;
  /** Human-readable task description. */
  readonly description: string;
  /** Task priority at creation time. */
  readonly priority: number;
  /** Current task state. */
  readonly state: 'created' | 'running' | 'blocked' | 'progressing' | 'completed' | 'failed' | 'cancelled';
  /** Epoch ms when the task was first observed (TASK_CREATED). */
  readonly createdAt: number;
  /** Epoch ms when the task reached a terminal state. */
  readonly completedAt?: number;
  /** Duration in ms (populated on terminal states). */
  readonly durationMs?: number;
  /** Progress value 0–100 (populated on TASK_PROGRESS). */
  readonly progress?: number;
  /** Latest progress message. */
  readonly progressMessage?: string;
  /** Reason the task is blocked (populated on TASK_BLOCKED). */
  readonly blockReason?: string;
  /** Error message (populated when state === 'failed'). */
  readonly error?: string;
  /** Trace identifier from the originating envelope. */
  readonly traceId: string;
  /** Session identifier from the originating envelope. */
  readonly sessionId: string;
}

// ── Event timeline entries ────────────────────────────────────────────────────

/**
 * Immutable entry in the event timeline.
 * Captures the full envelope context alongside the event type.
 */
export interface EventEntry {
  /** Unique monotonically increasing sequence number within this session. */
  readonly seq: number;
  /** Event type discriminant string. */
  readonly type: string;
  /** Domain this event belongs to. */
  readonly domain: string;
  /** Epoch ms when the event was emitted. */
  readonly ts: number;
  /** Distributed trace identifier. */
  readonly traceId: string;
  /** Session identifier. */
  readonly sessionId: string;
  /** Turn identifier (if scoped to a turn). */
  readonly turnId?: string;
  /** Agent identifier (if scoped to an agent). */
  readonly agentId?: string;
  /** Task identifier (if scoped to a task). */
  readonly taskId?: string;
  /** Source module or component that emitted the event. */
  readonly source: string;
  /** Condensed summary of the payload (key fields only, not full payload). */
  readonly summary: string;
}

// ── State inspector ───────────────────────────────────────────────────────────

/**
 * Domain state entry in the runtime state snapshot.
 * Each entry captures a single domain's serialized state.
 */
export interface DomainStateEntry {
  /** Domain name. */
  readonly domain: string;
  /** Revision counter at time of snapshot. */
  readonly revision: number;
  /** Epoch ms of last update. */
  readonly lastUpdatedAt: number;
  /** Serialized state as a plain object (JSON-safe). */
  readonly state: Record<string, unknown>;
}

/**
 * Full runtime state snapshot for the state inspector panel.
 */
export interface RuntimeStateSnapshot {
  /** Epoch ms when this snapshot was taken. */
  readonly capturedAt: number;
  /** All domain state entries. */
  readonly domains: readonly DomainStateEntry[];
}

// ── SLO status ───────────────────────────────────────────────────────────────

/**
 * Gate status for a single SLO metric.
 * - `ok`: current p95 is within the target threshold.
 * - `warn`: current p95 is within 20% above threshold (approaching violation).
 * - `violated`: current p95 exceeds the threshold.
 * - `no_data`: no samples have been collected yet.
 */
export type SloGateStatus = 'ok' | 'warn' | 'violated' | 'no_data';

/**
 * A single SLO metric row for display in the health dashboard.
 */
export interface SloRow {
  /** Metric key (e.g. 'slo.turn_start.p95'). */
  readonly metric: string;
  /** Human-readable name for the metric. */
  readonly name: string;
  /** Current p95 value in milliseconds. */
  readonly p95Ms: number;
  /** SLO target threshold in milliseconds. */
  readonly targetMs: number;
  /** Number of samples in the rolling window. */
  readonly sampleCount: number;
  /** Gate status derived from p95 vs target. */
  readonly status: SloGateStatus;
}

// ── Health dashboard ─────────────────────────────────────────────────────────

/**
 * Per-domain health summary for the health dashboard panel.
 */
export interface DomainHealthSummary {
  /** Domain name. */
  readonly domain: HealthDomain;
  /** Current health status. */
  readonly status: HealthStatus;
  /** Epoch ms of last transition. */
  readonly lastTransitionAt: number;
  /** Reduced capabilities when degraded. */
  readonly degradedCapabilities: readonly string[];
  /** Failure reason if applicable. */
  readonly failureReason?: string;
  /** Number of recovery attempts made. */
  readonly recoveryAttempts: number;
}

/**
 * A single remediation action surface in the health dashboard.
 * Maps to a playbook that provides resolution steps for a cascade failure.
 */
export interface RemediationAction {
  /** Playbook ID (matches Playbook.id). */
  readonly playbookId: string;
  /** Human-readable name of the playbook. */
  readonly playbookName: string;
  /** The cascade rule ID that triggered the need for this remediation. */
  readonly ruleId: string;
  /** Source domain that triggered the cascade. */
  readonly sourceDomain: HealthDomain;
  /** Severity tier of the triggering cascade. */
  readonly severity: string;
}

/**
 * Aggregated health dashboard data for rendering.
 */
export interface HealthDashboardData {
  /** Overall system health status. */
  readonly overall: HealthStatus;
  /** Per-domain health summaries. */
  readonly domains: readonly DomainHealthSummary[];
  /** Domains currently degraded. */
  readonly degradedDomains: readonly HealthDomain[];
  /** Domains currently failed. */
  readonly failedDomains: readonly HealthDomain[];
  /** Epoch ms of the last health update. */
  readonly lastUpdatedAt: number;
  /** SLO metric status rows. Empty when no SloCollector is attached. */
  readonly sloRows: readonly SloRow[];
  /**
   * Actionable remediation steps derived from active cascade results.
   * Empty when no cascades are pending or no playbook mappings exist.
   */
  readonly remediationActions: readonly RemediationAction[];
}

// ── Panel config ─────────────────────────────────────────────────────────────

/**
 * Configuration for a single diagnostic panel data provider.
 */
export interface PanelConfig {
  /** Maximum number of entries retained in the buffer. */
  readonly bufferLimit: number;
}

/**
 * Default panel configuration used when none is provided.
 */
export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  bufferLimit: DEFAULT_BUFFER_LIMIT,
};

// ── Tool Contract entries ────────────────────────────────────────────────────

/**
 * Severity of a single tool contract violation.
 * Mirrors ContractViolationSeverity from the contract-verifier module.
 */
export type ContractViolationSeverity = 'error' | 'warn';

/**
 * A single contract check failure or warning for a registered tool.
 */
export interface ToolContractViolation {
  /** Which of the 5 contract dimensions this violation belongs to. */
  readonly dimension:
    | 'schema'
    | 'timeout-cancellation'
    | 'permission-class'
    | 'output-policy'
    | 'idempotency';
  /** Severity of the violation. */
  readonly severity: ContractViolationSeverity;
  /** Human-readable explanation of what is wrong. */
  readonly message: string;
  /** Optional hint for how to fix the violation. */
  readonly hint?: string;
}

/**
 * Immutable diagnostic entry for a single tool's contract verification result.
 */
export interface ToolContractEntry {
  /** Tool name. */
  readonly toolName: string;
  /** Whether the tool passed all required (error-level) checks. */
  readonly passed: boolean;
  /** All violations found. May include warnings even when passed. */
  readonly violations: readonly ToolContractViolation[];
  /** Unix timestamp (ms) when this result was produced. */
  readonly verifiedAt: number;
  /** Whether this tool implements the PhasedTool interface. */
  readonly isPhasedTool: boolean;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Apply a DiagnosticFilter to an array of entries.
 * Entries must have at minimum: `sessionId`, `traceId`, and a timestamp field.
 * The `timestampField` parameter names the property used for time range checks.
 *
 * @param entries - Source array (most recent last).
 * @param filter - Filter to apply.
 * @param getTimestamp - Accessor for the entry's primary timestamp.
 * @returns Filtered array, most recent first, capped at filter.limit.
 */
export function applyFilter<T extends { sessionId: string; traceId: string }>(
  entries: readonly T[],
  filter: DiagnosticFilter | undefined,
  getTimestamp: (entry: T) => number,
): T[] {
  if (!filter) {
    return [...entries].reverse();
  }

  let result = [...entries];

  if (filter.sessionId !== undefined) {
    result = result.filter((e) => e.sessionId === filter.sessionId);
  }
  if (filter.traceId !== undefined) {
    result = result.filter((e) => e.traceId === filter.traceId);
  }
  if (filter.since !== undefined) {
    const since = filter.since;
    result = result.filter((e) => getTimestamp(e) >= since);
  }
  if (filter.until !== undefined) {
    const until = filter.until;
    result = result.filter((e) => getTimestamp(e) <= until);
  }

  // Most recent first
  result.reverse();

  const limit = filter.limit ?? DEFAULT_BUFFER_LIMIT;
  return result.slice(0, limit);
}

/**
 * Append an entry to a bounded buffer, discarding the oldest entry when
 * the limit is exceeded.
 *
 * @param buffer - Mutable buffer array (oldest first).
 * @param entry - Entry to append.
 * @param limit - Maximum buffer size.
 */
export function appendBounded<T>(buffer: T[], entry: T, limit: number): void {
  buffer.push(entry);
  if (buffer.length > limit) {
    buffer.shift();
  }
}
