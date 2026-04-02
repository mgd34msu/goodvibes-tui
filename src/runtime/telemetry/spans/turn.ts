/**
 * Turn lifecycle span helpers.
 *
 * Creates and manages spans that track the full turn lifecycle:
 * TURN_SUBMITTED → TURN_COMPLETED | TURN_ERROR | TURN_CANCEL
 *
 * The turn span is the root span for a conversation turn. Tool and LLM
 * spans are created as children of the turn span.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a turn span. */
export interface TurnSpanContext {
  /** Turn ID from the event envelope. */
  readonly turnId: string;
  /** Session-level trace ID for correlation. */
  readonly traceId: string;
  /** Session ID. */
  readonly sessionId: string;
  /** User prompt (truncated to 256 chars for the attribute). */
  readonly prompt: string;
}

/** Result context supplied when ending a turn span. */
export interface TurnSpanEndContext {
  /** Final outcome of the turn. */
  readonly outcome: 'completed' | 'error' | 'cancelled';
  /** Error message if outcome is 'error'. */
  readonly error?: string;
  /** Cancel reason if outcome is 'cancelled'. */
  readonly cancelReason?: string;
  /** Token usage if available. */
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
  };
}

/**
 * Start a turn lifecycle span.
 *
 * The returned Span should be stored and ended when the turn resolves
 * via `endTurnSpan`.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Turn context from TURN_SUBMITTED event.
 */
export function startTurnSpan(tracer: RuntimeTracer, ctx: TurnSpanContext): Span {
  const attrs: SpanAttributes = {
    'turn.id': ctx.turnId,
    'session.id': ctx.sessionId,
    // Truncate prompt to avoid large attribute values
    'turn.prompt': ctx.prompt.length > 256 ? ctx.prompt.slice(0, 256) + '...' : ctx.prompt,
  };

  return tracer.startSpan('turn.lifecycle', {
    traceId: ctx.traceId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * End a turn lifecycle span with outcome context.
 *
 * @param span - The span returned by `startTurnSpan`.
 * @param ctx - Turn end context.
 */
export function endTurnSpan(span: Span, ctx: TurnSpanEndContext): void {
  if (span.ended) return;

  span.addEvent(`turn.${ctx.outcome}`);
  span.setAttribute('turn.outcome', ctx.outcome);

  if (ctx.tokens) {
    span.setAttributes({
      'turn.tokens.input': ctx.tokens.input,
      'turn.tokens.output': ctx.tokens.output,
      'turn.tokens.cache_read': ctx.tokens.cacheRead ?? 0,
    });
  }

  if (ctx.outcome === 'error' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('turn.error', ctx.error);
  } else if (ctx.outcome === 'cancelled') {
    span.setStatus({ code: SpanStatusCode.OK });
    if (ctx.cancelReason) {
      span.setAttribute('turn.cancel_reason', ctx.cancelReason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
