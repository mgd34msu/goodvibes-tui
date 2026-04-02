/**
 * LLM provider call span helpers.
 *
 * Creates child spans under a turn span to track provider API calls.
 * These spans capture model, token usage, latency, and error context.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting an LLM span. */
export interface LlmSpanContext {
  /** Turn ID this LLM call belongs to. */
  readonly turnId: string;
  /** Provider name (e.g. 'anthropic', 'openai'). */
  readonly provider: string;
  /** Model ID (e.g. 'claude-sonnet-4-6'). */
  readonly model: string;
  /** Trace ID from the parent turn span. */
  readonly traceId: string;
  /** Parent span ID (the turn span's spanId). */
  readonly parentSpanId: string;
  /** Whether this is a streaming call. */
  readonly streaming?: boolean;
  /** Number of messages in the request context. */
  readonly messageCount?: number;
}

/** Token usage recorded when ending an LLM span. */
export interface LlmTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Result context supplied when ending an LLM span. */
export interface LlmSpanEndContext {
  /** Whether the call succeeded. */
  readonly success: boolean;
  /** Stop reason from the provider (e.g. 'end_turn', 'tool_use', 'max_tokens'). */
  readonly stopReason?: string;
  /** Token usage if available. */
  readonly tokens?: LlmTokenUsage;
  /** Error message if success is false. */
  readonly error?: string;
  /** HTTP status code if available (for remote provider calls). */
  readonly httpStatus?: number;
}

/**
 * Start an LLM provider call span as a child of the turn span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - LLM span context.
 */
export function startLlmSpan(tracer: RuntimeTracer, ctx: LlmSpanContext): Span {
  const attrs: SpanAttributes = {
    'llm.provider': ctx.provider,
    'llm.model': ctx.model,
    'turn.id': ctx.turnId,
    'llm.streaming': ctx.streaming ?? false,
  };

  if (ctx.messageCount !== undefined) {
    attrs['llm.message_count'] = ctx.messageCount;
  }

  return tracer.startSpan('llm.call', {
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
    // LLM calls are modelled as CLIENT spans (calling an external service)
    kind: SpanKind.CLIENT,
    attributes: attrs,
  });
}

/**
 * Record that the LLM stream has started (first token received).
 *
 * @param span - The active LLM span.
 * @param firstTokenMs - Epoch ms when the first token arrived (optional override).
 */
export function recordLlmStreamStart(span: Span, firstTokenMs?: number): void {
  if (span.ended) return;
  span.addEvent('llm.stream_start', {
    'llm.time_to_first_token_ms': firstTokenMs ?? Date.now(),
  });
}

/**
 * End an LLM provider call span.
 *
 * @param span - The span returned by `startLlmSpan`.
 * @param ctx - LLM end context.
 */
export function endLlmSpan(span: Span, ctx: LlmSpanEndContext): void {
  if (span.ended) return;

  if (ctx.stopReason) {
    span.setAttribute('llm.stop_reason', ctx.stopReason);
  }

  if (ctx.httpStatus !== undefined) {
    span.setAttribute('llm.http_status', ctx.httpStatus);
  }

  if (ctx.tokens) {
    span.setAttributes({
      'llm.tokens.input': ctx.tokens.inputTokens,
      'llm.tokens.output': ctx.tokens.outputTokens,
      'llm.tokens.cache_read': ctx.tokens.cacheReadTokens ?? 0,
      'llm.tokens.cache_write': ctx.tokens.cacheWriteTokens ?? 0,
    });
  }

  if (ctx.success) {
    span.setStatus({ code: SpanStatusCode.OK });
    span.addEvent('llm.call_completed');
  } else {
    const msg = ctx.error ?? 'LLM call failed';
    span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
    span.setAttribute('llm.error', msg);
    span.addEvent('llm.call_failed', { 'llm.error': msg });
  }

  span.end();
}
