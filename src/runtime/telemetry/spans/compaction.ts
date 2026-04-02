/**
 * Compaction lifecycle span helpers.
 *
 * Tracks the full context compaction state machine:
 * COMPACTION_CHECK | COMPACTION_AUTOCOMPACT | COMPACTION_REACTIVE
 * → COMPACTION_MICROCOMPACT | COMPACTION_COLLAPSE | COMPACTION_BOUNDARY_COMMIT
 * Terminal states: COMPACTION_DONE | COMPACTION_FAILED
 *
 * One span per compaction cycle. Captures token deltas and strategy.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a compaction lifecycle span. */
export interface CompactionSpanContext {
  /** Session ID this compaction is running for. */
  readonly sessionId: string;
  /** Compaction strategy (e.g. 'microcompact', 'collapse', 'auto'). */
  readonly strategy: string;
  /** Token count at the time compaction was triggered. */
  readonly tokenCount: number;
  /** Token threshold that triggered compaction (if applicable). */
  readonly threshold?: number;
  /** Context limit that triggered reactive compaction (if applicable). */
  readonly limit?: number;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
}

/** Phase transitions recordable on a compaction lifecycle span. */
export type CompactionPhase =
  | 'microcompact'
  | 'collapse'
  | 'boundary_commit';

/** Result context supplied when ending a compaction lifecycle span. */
export interface CompactionSpanEndContext {
  /** Final outcome of the compaction cycle. */
  readonly outcome: 'done' | 'failed';
  /** Token count before compaction. */
  readonly tokensBefore: number;
  /** Token count after compaction (only set when outcome is 'done'). */
  readonly tokensAfter?: number;
  /** Duration of the compaction in milliseconds (only set when outcome is 'done'). */
  readonly durationMs?: number;
  /** Error description when outcome is 'failed'. */
  readonly error?: string;
  /** ID of the compaction checkpoint committed (when applicable). */
  readonly checkpointId?: string;
}

/**
 * Start a compaction lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from COMPACTION_CHECK, COMPACTION_AUTOCOMPACT, or COMPACTION_REACTIVE.
 */
export function startCompactionSpan(tracer: RuntimeTracer, ctx: CompactionSpanContext): Span {
  const attrs: SpanAttributes = {
    'compaction.session_id': ctx.sessionId,
    'compaction.strategy': ctx.strategy,
    'compaction.tokens_before': ctx.tokenCount,
  };

  if (ctx.threshold !== undefined) {
    attrs['compaction.threshold'] = ctx.threshold;
  }
  if (ctx.limit !== undefined) {
    attrs['compaction.limit'] = ctx.limit;
  }

  return tracer.startSpan('compaction.lifecycle', {
    traceId: ctx.traceId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record a compaction phase transition event.
 *
 * @param span - The active compaction lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordCompactionPhase(
  span: Span,
  phase: CompactionPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`compaction.${phase}`, attrs);
}

/**
 * End a compaction lifecycle span.
 *
 * @param span - The span returned by `startCompactionSpan`.
 * @param ctx - Compaction lifecycle end context.
 */
export function endCompactionSpan(span: Span, ctx: CompactionSpanEndContext): void {
  if (span.ended) return;

  span.setAttributes({
    'compaction.outcome': ctx.outcome,
    'compaction.tokens_before': ctx.tokensBefore,
  });

  if (ctx.tokensAfter !== undefined) {
    span.setAttribute('compaction.tokens_after', ctx.tokensAfter);
    span.setAttribute(
      'compaction.tokens_saved',
      ctx.tokensBefore - ctx.tokensAfter
    );
  }

  if (ctx.durationMs !== undefined) {
    span.setAttribute('compaction.duration_ms', ctx.durationMs);
  }

  if (ctx.checkpointId !== undefined) {
    span.setAttribute('compaction.checkpoint_id', ctx.checkpointId);
  }

  span.addEvent(`compaction.${ctx.outcome}`);

  if (ctx.outcome === 'failed' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('compaction.error', ctx.error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
