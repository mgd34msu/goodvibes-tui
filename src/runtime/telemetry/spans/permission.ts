/**
 * Permission decision span helpers.
 *
 * Tracks the full permission evaluation pipeline:
 * PERMISSION_REQUESTED → RULES_COLLECTED → INPUT_NORMALIZED
 * → POLICY_EVALUATED → MODE_EVALUATED → SESSION_OVERRIDE_EVALUATED
 * → SAFETY_CHECKED → DECISION_EMITTED
 *
 * One span per permission decision. Child of the active tool span
 * when a parentSpanId is supplied.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a permission decision span. */
export interface PermissionSpanContext {
  /** Tool call ID this permission decision covers. */
  readonly callId: string;
  /** Tool name being evaluated. */
  readonly tool: string;
  /** Permission category (e.g. 'filesystem', 'network'). */
  readonly category: string;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
  /**
   * Optional parent span ID for nesting under a tool span.
   * When provided, this permission span becomes a child of the tool span.
   */
  readonly parentSpanId?: string;
}

/** Phase transitions recordable on a permission decision span. */
export type PermissionPhase =
  | 'rules_collected'
  | 'input_normalized'
  | 'policy_evaluated'
  | 'mode_evaluated'
  | 'session_override_evaluated'
  | 'safety_checked';

/** Result context supplied when ending a permission decision span. */
export interface PermissionSpanEndContext {
  /** Whether the tool call was approved. */
  readonly approved: boolean;
  /** Decision source (e.g. 'policy', 'mode', 'session_override', 'safety'). */
  readonly source: string;
  /** Whether the input was deemed safe. */
  readonly safe?: boolean;
  /** Safety warnings if any were raised. */
  readonly warnings?: string[];
}

/**
 * Start a permission decision span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from PERMISSION_REQUESTED event.
 */
export function startPermissionSpan(tracer: RuntimeTracer, ctx: PermissionSpanContext): Span {
  const attrs: SpanAttributes = {
    'permission.call_id': ctx.callId,
    'permission.tool': ctx.tool,
    'permission.category': ctx.category,
  };

  return tracer.startSpan('permission.decision', {
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record a permission evaluation phase transition.
 *
 * @param span - The active permission decision span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordPermissionPhase(
  span: Span,
  phase: PermissionPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`permission.${phase}`, attrs);
}

/**
 * End a permission decision span.
 *
 * @param span - The span returned by `startPermissionSpan`.
 * @param ctx - Permission decision end context.
 */
export function endPermissionSpan(span: Span, ctx: PermissionSpanEndContext): void {
  if (span.ended) return;

  span.setAttributes({
    'permission.approved': ctx.approved,
    'permission.source': ctx.source,
  });

  if (ctx.safe !== undefined) {
    span.setAttribute('permission.safe', ctx.safe);
  }

  if (ctx.warnings !== undefined && ctx.warnings.length > 0) {
    span.setAttribute('permission.warning_count', ctx.warnings.length);
  }

  span.addEvent(ctx.approved ? 'permission.approved' : 'permission.denied');

  if (!ctx.approved) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Permission denied by ${ctx.source}`,
    });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
