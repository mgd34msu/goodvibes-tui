/**
 * ToolEvent — discriminated union covering all tool execution lifecycle events.
 *
 * Covers tool execution lifecycle events for the runtime event bus.
 */

export type ToolEvent =
  /** A tool call request was received from the LLM. */
  | { type: 'TOOL_RECEIVED'; callId: string; turnId: string; tool: string; args: Record<string, unknown> }
  /** Tool call arguments passed schema validation. */
  | { type: 'TOOL_VALIDATED'; callId: string; turnId: string; tool: string }
  /** Pre-execution hooks have run for this tool call. */
  | { type: 'TOOL_PREHOOKED'; callId: string; turnId: string; tool: string }
  /** Permission check completed; call may proceed. */
  | { type: 'TOOL_PERMISSIONED'; callId: string; turnId: string; tool: string; approved: boolean }
  /** Tool is actively executing. */
  | { type: 'TOOL_EXECUTING'; callId: string; turnId: string; tool: string; startedAt: number }
  /** Tool result has been mapped/transformed for the provider. */
  | { type: 'TOOL_MAPPED'; callId: string; turnId: string; tool: string }
  /** Post-execution hooks have run for this tool call. */
  | { type: 'TOOL_POSTHOOKED'; callId: string; turnId: string; tool: string }
  /** Tool call completed successfully. */
  | { type: 'TOOL_SUCCEEDED'; callId: string; turnId: string; tool: string; durationMs: number; result?: unknown }
  /** Tool call failed with an error. */
  | { type: 'TOOL_FAILED'; callId: string; turnId: string; tool: string; error: string; durationMs: number; result?: unknown }
  /** Tool results were synthesized to reconcile unresolved calls. */
  | {
      type: 'TOOL_RECONCILED';
      turnId: string;
      count: number;
      callIds: string[];
      toolNames: string[];
      reason: string;
      timestamp: number;
      isMalformed?: boolean;
    }
  /** Tool call was cancelled before completion. */
  | { type: 'TOOL_CANCELLED'; callId: string; turnId: string; tool: string; reason?: string }
  /**
   * A runtime budget was exceeded and the phase pipeline was terminated.
   * The `reason` discriminant distinguishes the type of budget breached:
   *  - BUDGET_EXCEEDED_MS    — wall-clock execution time limit
   *  - BUDGET_EXCEEDED_TOKENS — token consumption limit
   *  - BUDGET_EXCEEDED_COST  — cost limit in USD
   */
  | {
      type: 'BUDGET_EXCEEDED_MS';
      callId: string;
      turnId: string;
      tool: string;
      phase: string;
      limitMs: number;
      elapsedMs: number;
    }
  | {
      type: 'BUDGET_EXCEEDED_TOKENS';
      callId: string;
      turnId: string;
      tool: string;
      phase: string;
      limitTokens: number;
      usedTokens: number;
    }
  | {
      type: 'BUDGET_EXCEEDED_COST';
      callId: string;
      turnId: string;
      tool: string;
      phase: string;
      limitCostUsd: number;
      usedCostUsd: number;
    };

/** All tool event type literals as a union. */
export type ToolEventType = ToolEvent['type'];
