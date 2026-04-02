/**
 * Transport lifecycle span helpers.
 *
 * Tracks the full transport state machine:
 * TRANSPORT_INITIALIZING → TRANSPORT_AUTHENTICATING → TRANSPORT_CONNECTED
 * → TRANSPORT_SYNCING → TRANSPORT_DEGRADED → TRANSPORT_RECONNECTING
 * Terminal states: TRANSPORT_DISCONNECTED | TRANSPORT_TERMINAL_FAILURE
 *
 * One span per transport connection session.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a transport lifecycle span. */
export interface TransportSpanContext {
  /** Transport ID. */
  readonly transportId: string;
  /** Protocol name (e.g. 'websocket', 'stdio', 'http'). */
  readonly protocol: string;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
}

/** Phase transitions recordable on a transport lifecycle span. */
export type TransportPhase =
  | 'authenticating'
  | 'connected'
  | 'syncing'
  | 'degraded'
  | 'reconnecting';

/** Result context supplied when ending a transport lifecycle span. */
export interface TransportSpanEndContext {
  /** Final outcome of the transport lifecycle. */
  readonly outcome: 'connected' | 'disconnected' | 'terminal_failure';
  /** Disconnect or failure reason if applicable. */
  readonly reason?: string;
  /** Whether a reconnect will be attempted. */
  readonly willRetry?: boolean;
  /** Remote endpoint address when outcome is 'connected'. */
  readonly endpoint?: string;
}

/**
 * Start a transport lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from TRANSPORT_INITIALIZING event.
 */
export function startTransportSpan(tracer: RuntimeTracer, ctx: TransportSpanContext): Span {
  const attrs: SpanAttributes = {
    'transport.id': ctx.transportId,
    'transport.protocol': ctx.protocol,
  };

  return tracer.startSpan('transport.lifecycle', {
    traceId: ctx.traceId,
    kind: SpanKind.CLIENT,
    attributes: attrs,
  });
}

/**
 * Record a transport phase transition event.
 *
 * @param span - The active transport lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordTransportPhase(
  span: Span,
  phase: TransportPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`transport.${phase}`, attrs);
}

/**
 * End a transport lifecycle span.
 *
 * @param span - The span returned by `startTransportSpan`.
 * @param ctx - Transport lifecycle end context.
 */
export function endTransportSpan(span: Span, ctx: TransportSpanEndContext): void {
  if (span.ended) return;

  span.setAttribute('transport.outcome', ctx.outcome);

  if (ctx.endpoint !== undefined) {
    span.setAttribute('transport.endpoint', ctx.endpoint);
  }
  if (ctx.willRetry !== undefined) {
    span.setAttribute('transport.will_retry', ctx.willRetry);
  }

  span.addEvent(`transport.${ctx.outcome}`);

  if (ctx.outcome === 'terminal_failure') {
    const msg = ctx.reason ?? 'Transport terminal failure';
    span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
    span.setAttribute('transport.error', msg);
  } else if (ctx.outcome === 'disconnected' && !ctx.willRetry) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.reason ?? 'Transport disconnected' });
    if (ctx.reason) {
      span.setAttribute('transport.disconnect_reason', ctx.reason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
