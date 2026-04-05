/**
 * TurnEvent — discriminated union covering all conversation turn lifecycle events.
 *
 * Maps to the typed runtime event contract for the  domain.
 */
import type { PartialToolCall } from '../../providers/interface.ts';

export type TurnStopReason =
  | 'completed'
  | 'empty_response'
  | 'preflight_failed'
  | 'context_overflow'
  | 'provider_exhausted'
  | 'provider_error'
  | 'hook_denied'
  | 'tool_loop_circuit_breaker'
  | 'cancelled'
  | 'unexpected_error';

export type TurnEvent =
  /** User prompt has been submitted for processing. */
  | { type: 'TURN_SUBMITTED'; turnId: string; prompt: string }
  /** Preflight checks (context, rate limits, etc.) passed. */
  | { type: 'PREFLIGHT_OK'; turnId: string }
  /** Preflight checks failed; turn will not proceed. */
  | { type: 'PREFLIGHT_FAIL'; turnId: string; reason: string; stopReason: Extract<TurnStopReason, 'preflight_failed' | 'context_overflow'> }
  /** Streaming response has begun. */
  | { type: 'STREAM_START'; turnId: string }
  /** An incremental content chunk arrived from the provider. */
  | { type: 'STREAM_DELTA'; turnId: string; content: string; accumulated: string; reasoning?: string; toolCalls?: PartialToolCall[] }
  /** Streaming has ended. */
  | { type: 'STREAM_END'; turnId: string }
  /** A provider chat call completed within the current turn iteration. */
  | {
    type: 'LLM_RESPONSE_RECEIVED';
    turnId: string;
    provider: string;
    model: string;
    content: string;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }
  /** A batch of tool calls is ready for execution. */
  | { type: 'TOOL_BATCH_READY'; turnId: string; toolCalls: string[] }
  /** All tool calls in the current batch have completed. */
  | { type: 'TOOLS_DONE'; turnId: string }
  /** Post-processing hooks (WRFC, formatters, etc.) have completed. */
  | { type: 'POST_HOOKS_DONE'; turnId: string }
  /** Turn completed successfully with a final response. */
  | { type: 'TURN_COMPLETED'; turnId: string; response: string; stopReason: Extract<TurnStopReason, 'completed' | 'empty_response'> }
  /** Turn failed with an error. */
  | { type: 'TURN_ERROR'; turnId: string; error: string; stopReason: Exclude<TurnStopReason, 'completed' | 'empty_response' | 'cancelled'> }
  /** Turn was cancelled by the user or system. */
  | { type: 'TURN_CANCEL'; turnId: string; reason?: string; stopReason: Extract<TurnStopReason, 'cancelled'> };

/** All turn event type literals as a union. */
export type TurnEventType = TurnEvent['type'];
