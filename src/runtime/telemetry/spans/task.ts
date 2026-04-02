/**
 * Task lifecycle span helpers.
 *
 * Tracks the full task state machine:
 * TASK_CREATED → TASK_STARTED → TASK_BLOCKED → TASK_PROGRESS
 * Terminal states: TASK_COMPLETED | TASK_FAILED | TASK_CANCELLED
 *
 * One span per task. Optionally parented to an agent span.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a task lifecycle span. */
export interface TaskSpanContext {
  /** Task ID (unique). */
  readonly taskId: string;
  /** Optional agent ID that owns this task. */
  readonly agentId?: string;
  /** Human-readable task description. */
  readonly description: string;
  /** Task scheduling priority. */
  readonly priority: number;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
  /**
   * Optional parent span ID for nesting under an agent span.
   * When provided, this task span becomes a child of the agent span.
   */
  readonly parentSpanId?: string;
}

/** Phase transitions recordable on a task lifecycle span. */
export type TaskPhase = 'started' | 'blocked' | 'progress';

/** Result context supplied when ending a task lifecycle span. */
export interface TaskSpanEndContext {
  /** Final outcome of the task. */
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  /** Duration of the task in milliseconds. */
  readonly durationMs: number;
  /** Error description when outcome is 'failed'. */
  readonly error?: string;
  /** Cancel reason when outcome is 'cancelled'. */
  readonly reason?: string;
}

/**
 * Start a task lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from TASK_CREATED event.
 */
export function startTaskSpan(tracer: RuntimeTracer, ctx: TaskSpanContext): Span {
  const attrs: SpanAttributes = {
    'task.id': ctx.taskId,
    'task.description': ctx.description.length > 256
      ? ctx.description.slice(0, 256) + '...'
      : ctx.description,
    'task.priority': ctx.priority,
  };

  if (ctx.agentId !== undefined) {
    attrs['agent.id'] = ctx.agentId;
  }

  return tracer.startSpan('task.lifecycle', {
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record a task phase transition event.
 *
 * @param span - The active task lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordTaskPhase(
  span: Span,
  phase: TaskPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`task.${phase}`, attrs);
}

/**
 * End a task lifecycle span.
 *
 * @param span - The span returned by `startTaskSpan`.
 * @param ctx - Task lifecycle end context.
 */
export function endTaskSpan(span: Span, ctx: TaskSpanEndContext): void {
  if (span.ended) return;

  span.setAttributes({
    'task.outcome': ctx.outcome,
    'task.duration_ms': ctx.durationMs,
  });

  span.addEvent(`task.${ctx.outcome}`);

  if (ctx.outcome === 'failed' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('task.error', ctx.error);
  } else if (ctx.outcome === 'cancelled') {
    span.setStatus({ code: SpanStatusCode.OK });
    if (ctx.reason) {
      span.setAttribute('task.cancel_reason', ctx.reason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
