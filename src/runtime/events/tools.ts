/**
 * ToolEvent — discriminated union covering all tool execution lifecycle events.
 *
 * Maps to state machine events from v3 Section 4 (Tools domain).
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
  | { type: 'TOOL_SUCCEEDED'; callId: string; turnId: string; tool: string; durationMs: number }
  /** Tool call failed with an error. */
  | { type: 'TOOL_FAILED'; callId: string; turnId: string; tool: string; error: string; durationMs: number }
  /** Tool call was cancelled before completion. */
  | { type: 'TOOL_CANCELLED'; callId: string; turnId: string; tool: string; reason?: string };

/** All tool event type literals as a union. */
export type ToolEventType = ToolEvent['type'];
