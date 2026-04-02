/**
 * Tool execution span helpers.
 *
 * Creates child spans under a turn span to track the full tool execution
 * pipeline: TOOL_RECEIVED → TOOL_VALIDATED → TOOL_PREHOOKED →
 * TOOL_PERMISSIONED → TOOL_EXECUTING → TOOL_SUCCEEDED | TOOL_FAILED | TOOL_CANCELLED
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a tool span. */
export interface ToolSpanContext {
  /** Tool call ID (unique per call). */
  readonly callId: string;
  /** Turn ID this tool call belongs to. */
  readonly turnId: string;
  /** Tool name (e.g. 'precision_read'). */
  readonly tool: string;
  /** Trace ID from the parent turn span. */
  readonly traceId: string;
  /** Parent span ID (the turn span's spanId). */
  readonly parentSpanId: string;
  /** Tool call arguments (stored as JSON string, truncated). */
  readonly args?: Record<string, unknown>;
}

/** Phase transition events that can be recorded on a tool span. */
export type ToolPhase =
  | 'validated'
  | 'prehooked'
  | 'permissioned'
  | 'executing'
  | 'mapped'
  | 'posthooked';

/** Result context supplied when ending a tool span. */
export interface ToolSpanEndContext {
  /** Final outcome. */
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  /** Duration in ms. */
  readonly durationMs: number;
  /** Error message if outcome is 'failed'. */
  readonly error?: string;
  /** Cancel reason if outcome is 'cancelled'. */
  readonly cancelReason?: string;
  /** Whether the tool call was approved by permissions. */
  readonly approved?: boolean;
}

/**
 * Start a tool execution span as a child of the turn span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Tool span context from TOOL_RECEIVED event.
 */
export function startToolSpan(tracer: RuntimeTracer, ctx: ToolSpanContext): Span {
  const argsJson = ctx.args
    ? (() => {
        const raw = JSON.stringify(ctx.args);
        return raw.length > 512 ? raw.slice(0, 512) + '...' : raw;
      })()
    : '';

  const attrs: SpanAttributes = {
    'tool.name': ctx.tool,
    'tool.call_id': ctx.callId,
    'turn.id': ctx.turnId,
    'tool.args': argsJson,
  };

  return tracer.startSpan('tool.execute', {
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record a phase transition event on a tool span.
 *
 * @param span - The active tool span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes for this phase.
 */
export function recordToolPhase(
  span: Span,
  phase: ToolPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`tool.${phase}`, attrs);
}

/**
 * End a tool execution span.
 *
 * @param span - The span returned by `startToolSpan`.
 * @param ctx - Tool end context.
 */
export function endToolSpan(span: Span, ctx: ToolSpanEndContext): void {
  if (span.ended) return;

  span.setAttributes({
    'tool.outcome': ctx.outcome,
    'tool.duration_ms': ctx.durationMs,
  });

  if (ctx.approved !== undefined) {
    span.setAttribute('tool.approved', ctx.approved);
  }

  span.addEvent(`tool.${ctx.outcome}`);

  if (ctx.outcome === 'failed' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('tool.error', ctx.error);
  } else if (ctx.outcome === 'cancelled') {
    span.setStatus({ code: SpanStatusCode.OK });
    if (ctx.cancelReason) {
      span.setAttribute('tool.cancel_reason', ctx.cancelReason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
