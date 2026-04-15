/**
 * Turn emitters — typed emission wrappers for TurnEvent domain.
 *
 * Import and call these instead of emitting raw strings.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import type { PartialToolCall } from '@pellux/goodvibes-sdk/platform/providers/interface';

/** Emit TURN_SUBMITTED when a user prompt is submitted. */
export function emitTurnSubmitted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string; prompt: string }
): void {
  bus.emit('turn', createEventEnvelope('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', ...data }, ctx));
}

/** Emit PREFLIGHT_OK when preflight checks pass. */
export function emitPreflightOk(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string }
): void {
  bus.emit('turn', createEventEnvelope('PREFLIGHT_OK', { type: 'PREFLIGHT_OK', ...data }, ctx));
}

/** Emit PREFLIGHT_FAIL when preflight checks fail. */
export function emitPreflightFail(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    turnId: string;
    reason: string;
    stopReason: 'preflight_failed' | 'context_overflow';
  }
): void {
  bus.emit('turn', createEventEnvelope('PREFLIGHT_FAIL', { type: 'PREFLIGHT_FAIL', ...data }, ctx));
}

/** Emit STREAM_START when provider streaming begins. */
export function emitStreamStart(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string }
): void {
  bus.emit('turn', createEventEnvelope('STREAM_START', { type: 'STREAM_START', ...data }, ctx));
}

/** Emit STREAM_DELTA for each incremental content chunk. */
export function emitStreamDelta(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string; content: string; accumulated: string; reasoning?: string; toolCalls?: PartialToolCall[] }
): void {
  bus.emit('turn', createEventEnvelope('STREAM_DELTA', { type: 'STREAM_DELTA', ...data }, ctx));
}

/** Emit STREAM_END when provider streaming ends. */
export function emitStreamEnd(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string }
): void {
  bus.emit('turn', createEventEnvelope('STREAM_END', { type: 'STREAM_END', ...data }, ctx));
}

/** Emit LLM_RESPONSE_RECEIVED when a provider chat call completes within a turn iteration. */
export function emitLlmResponseReceived(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
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
): void {
  bus.emit('turn', createEventEnvelope('LLM_RESPONSE_RECEIVED', { type: 'LLM_RESPONSE_RECEIVED', ...data }, ctx));
}

/** Emit TOOL_BATCH_READY when a set of tool calls is ready for execution. */
export function emitToolBatchReady(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string; toolCalls: string[] }
): void {
  bus.emit('turn', createEventEnvelope('TOOL_BATCH_READY', { type: 'TOOL_BATCH_READY', ...data }, ctx));
}

/** Emit TOOLS_DONE when all tool calls in the current batch have completed. */
export function emitToolsDone(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string }
): void {
  bus.emit('turn', createEventEnvelope('TOOLS_DONE', { type: 'TOOLS_DONE', ...data }, ctx));
}

/** Emit POST_HOOKS_DONE when post-processing hooks have completed. */
export function emitPostHooksDone(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string }
): void {
  bus.emit('turn', createEventEnvelope('POST_HOOKS_DONE', { type: 'POST_HOOKS_DONE', ...data }, ctx));
}

/** Emit TURN_COMPLETED when the turn finishes successfully. */
export function emitTurnCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    turnId: string;
    response: string;
    stopReason: 'completed' | 'empty_response';
  }
): void {
  bus.emit('turn', createEventEnvelope('TURN_COMPLETED', { type: 'TURN_COMPLETED', ...data }, ctx));
}

/** Emit TURN_ERROR when the turn fails. */
export function emitTurnError(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    turnId: string;
    error: string;
    stopReason:
      | 'preflight_failed'
      | 'context_overflow'
      | 'provider_exhausted'
      | 'provider_error'
      | 'hook_denied'
      | 'tool_loop_circuit_breaker'
      | 'unexpected_error';
  }
): void {
  bus.emit('turn', createEventEnvelope('TURN_ERROR', { type: 'TURN_ERROR', ...data }, ctx));
}

/** Emit TURN_CANCEL when the turn is cancelled. */
export function emitTurnCancel(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { turnId: string; reason?: string; stopReason: 'cancelled' }
): void {
  bus.emit('turn', createEventEnvelope('TURN_CANCEL', { type: 'TURN_CANCEL', ...data }, ctx));
}
