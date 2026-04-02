/**
 * Session recovery span helpers.
 *
 * Tracks the full session lifecycle:
 * SESSION_STARTED | SESSION_LOADING → SESSION_RESUMED | SESSION_REPAIRING
 * → SESSION_RECONCILING → SESSION_READY
 * Terminal error state: SESSION_RECOVERY_FAILED
 *
 * One span per session initialisation / recovery attempt.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a session lifecycle span. */
export interface SessionSpanContext {
  /** Session ID. */
  readonly sessionId: string;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
  /** Profile ID used for this session (present on new sessions). */
  readonly profileId?: string;
  /** Working directory for this session (present on new sessions). */
  readonly workingDir?: string;
  /** Path to the saved session file (present on resumed sessions). */
  readonly path?: string;
}

/** Phase transitions recordable on a session lifecycle span. */
export type SessionPhase =
  | 'loading'
  | 'resumed'
  | 'repairing'
  | 'reconciling';

/** Result context supplied when ending a session lifecycle span. */
export interface SessionSpanEndContext {
  /** Final outcome of the session initialisation. */
  readonly outcome: 'ready' | 'recovery_failed';
  /** Error description when outcome is 'recovery_failed'. */
  readonly error?: string;
  /** Number of turns loaded on resume (if applicable). */
  readonly turnCount?: number;
  /** Number of messages reconciled (if applicable). */
  readonly messageCount?: number;
}

/**
 * Start a session lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from SESSION_STARTED or SESSION_LOADING event.
 */
export function startSessionSpan(tracer: RuntimeTracer, ctx: SessionSpanContext): Span {
  const attrs: SpanAttributes = {
    'session.id': ctx.sessionId,
  };

  if (ctx.profileId !== undefined) {
    attrs['session.profile_id'] = ctx.profileId;
  }
  if (ctx.workingDir !== undefined) {
    attrs['session.working_dir'] = ctx.workingDir;
  }
  if (ctx.path !== undefined) {
    attrs['session.path'] = ctx.path;
  }

  return tracer.startSpan('session.lifecycle', {
    traceId: ctx.traceId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record a session lifecycle phase transition.
 *
 * @param span - The active session lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordSessionPhase(
  span: Span,
  phase: SessionPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`session.${phase}`, attrs);
}

/**
 * End a session lifecycle span.
 *
 * @param span - The span returned by `startSessionSpan`.
 * @param ctx - Session lifecycle end context.
 */
export function endSessionSpan(span: Span, ctx: SessionSpanEndContext): void {
  if (span.ended) return;

  span.setAttribute('session.outcome', ctx.outcome);

  if (ctx.turnCount !== undefined) {
    span.setAttribute('session.turn_count', ctx.turnCount);
  }
  if (ctx.messageCount !== undefined) {
    span.setAttribute('session.message_count', ctx.messageCount);
  }

  span.addEvent(`session.${ctx.outcome}`);

  if (ctx.outcome === 'recovery_failed' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('session.error', ctx.error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
