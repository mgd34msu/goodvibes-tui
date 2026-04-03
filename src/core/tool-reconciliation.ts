/**
 * Tool result reconciliation types and utilities for GC-ORCH-015.
 *
 * Provides types and helpers for detecting and resolving unresolved tool calls
 * at turn end — ensuring no turn exits with dangling tool-call state.
 */
import type { ToolCall, ToolResult } from '../types/tools.ts';

/**
 * A synthetic tool result injected by the reconciliation pass when a provider
 * response includes a `tool_use` block that was never matched to a `tool_result`.
 *
 * Distinguishable from organic results by `synthetic: true` so consumers can
 * apply different rendering / telemetry treatment.
 */
export interface SyntheticToolResult extends ToolResult {
  /** Always `true` for reconciliation-injected results. */
  readonly synthetic: true;
  /** The reason the reconciliation pass created this result. */
  readonly reason: ReconciliationReason;
  /**
   * LLM-directed guidance for the model — separate from the operational `error`
   * field so telemetry and rendering can treat them independently.
   */
  readonly instruction?: string;
}

/**
 * Describes why the reconciler had to synthesize a tool result.
 *
 * - `'loop-exit-with-tool-use'`  — the turn loop exited (circuit breaker,
 *   agent-spawn, etc.) while tool calls were still unresolved.
 * - `'malformed-stop-reason'`    — the provider signalled `tool_use` stop
 *   but returned zero tool calls (malformed response).
 * - `'exception-before-results'` — the turn threw before tool results could
 *   be added to the conversation.
 * - `'unknown'`                   — catch-all for unanticipated scenarios.
 */
export type ReconciliationReason =
  | 'loop-exit-with-tool-use'
  | 'malformed-stop-reason'
  | 'exception-before-results'
  | 'unknown';

/**
 * Event emitted on the orchestrator's event bus whenever the reconciliation
 * pass synthesises at least one tool result.
 *
 * Consumers (telemetry, tests) can subscribe to `'turn:tool-reconciliation'`
 * to observe synthetic resolution events.
 */
export interface ReconciliationEvent {
  /** Number of dangling tool calls that were resolved synthetically. */
  count: number;
  /** IDs of the tool calls that were reconciled. */
  callIds: string[];
  /** Names of the tools involved. */
  toolNames: string[];
  /** The reason the reconciliation was triggered. */
  reason: ReconciliationReason;
  /** Unix timestamp (ms). */
  timestamp: number;
  /**
   * `true` when the event was triggered by a malformed provider response
   * (stopReason=tool_use with zero tool calls). Useful for telemetry triage.
   */
  isMalformed?: boolean;
}

/**
 * Builds a synthetic error result for a tool call that was never executed.
 *
 * @param call   - The dangling `ToolCall` from the provider response.
 * @param reason - Why reconciliation was triggered.
 * @returns A `SyntheticToolResult` safe to inject into the conversation.
 */
export function buildSyntheticResult(
  call: ToolCall,
  reason: ReconciliationReason,
): SyntheticToolResult {
  return {
    callId: call.id,
    success: false,
    error: `[RECONCILED] Tool call '${call.name}' (id: ${call.id}) was not executed — the turn ended before results could be produced. Reason: ${reason}.`,
    instruction: 'Do not retry the same call unless you are certain the underlying condition has changed.',
    synthetic: true,
    reason,
  };
}

/**
 * Determines whether a set of tool calls contains entries that were never
 * resolved (i.e., have no matching result in the provided results array).
 *
 * @param toolCalls - Tool calls from the provider response.
 * @param results   - Tool results collected during this turn.
 * @returns Array of unresolved `ToolCall` objects (may be empty).
 *
 * @note Uses Set semantics for resolved ID lookup: duplicate tool_use IDs in
 * `toolCalls` are each checked against the same resolved set, so both entries
 * are considered resolved if one result with that ID exists. The API spec
 * requires unique IDs, so duplicates are an error in provider output; treating
 * them as resolved prevents spurious synthetic results.
 */
export function detectUnresolvedToolCalls(
  toolCalls: ToolCall[],
  results: ToolResult[],
): ToolCall[] {
  const resolvedIds = new Set(results.map((r) => r.callId));
  return toolCalls.filter((c) => !resolvedIds.has(c.id));
}
