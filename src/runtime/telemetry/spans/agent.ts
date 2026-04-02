/**
 * Agent lifecycle span helpers.
 *
 * Tracks the full agent state machine:
 * AGENT_SPAWNING → AGENT_RUNNING → AGENT_AWAITING_MESSAGE → AGENT_AWAITING_TOOL
 * → AGENT_FINALIZING
 * Terminal states: AGENT_COMPLETED | AGENT_FAILED | AGENT_CANCELLED
 *
 * Agent spans are root spans (new trace per agent) or child of a turn span
 * when the agent was spawned within an interactive turn.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting an agent lifecycle span. */
export interface AgentSpanContext {
  /** Agent ID (unique per spawn). */
  readonly agentId: string;
  /** Task ID this agent is executing (if any). */
  readonly taskId?: string;
  /** Human-readable description of the agent task. */
  readonly task: string;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
  /**
   * Optional parent span ID for nesting under a turn span.
   * When provided, this agent span becomes a child of the parent.
   */
  readonly parentSpanId?: string;
}

/** Phase transitions recordable on an agent lifecycle span. */
export type AgentPhase =
  | 'running'
  | 'awaiting_message'
  | 'awaiting_tool'
  | 'finalizing';

/** Result context supplied when ending an agent lifecycle span. */
export interface AgentSpanEndContext {
  /** Final outcome of the agent. */
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  /** Duration of the agent run in milliseconds. */
  readonly durationMs: number;
  /** Error description when outcome is 'failed'. */
  readonly error?: string;
  /** Cancel reason when outcome is 'cancelled'. */
  readonly reason?: string;
}

/**
 * Start an agent lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from AGENT_SPAWNING event.
 */
export function startAgentSpan(tracer: RuntimeTracer, ctx: AgentSpanContext): Span {
  const attrs: SpanAttributes = {
    'agent.id': ctx.agentId,
    'agent.task': ctx.task.length > 256 ? ctx.task.slice(0, 256) + '...' : ctx.task,
  };

  if (ctx.taskId !== undefined) {
    attrs['task.id'] = ctx.taskId;
  }

  return tracer.startSpan('agent.lifecycle', {
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record an agent phase transition event.
 *
 * @param span - The active agent lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordAgentPhase(
  span: Span,
  phase: AgentPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`agent.${phase}`, attrs);
}

/**
 * End an agent lifecycle span.
 *
 * @param span - The span returned by `startAgentSpan`.
 * @param ctx - Agent lifecycle end context.
 */
export function endAgentSpan(span: Span, ctx: AgentSpanEndContext): void {
  if (span.ended) return;

  span.setAttributes({
    'agent.outcome': ctx.outcome,
    'agent.duration_ms': ctx.durationMs,
  });

  span.addEvent(`agent.${ctx.outcome}`);

  if (ctx.outcome === 'failed' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('agent.error', ctx.error);
  } else if (ctx.outcome === 'cancelled') {
    span.setStatus({ code: SpanStatusCode.OK });
    if (ctx.reason) {
      span.setAttribute('agent.cancel_reason', ctx.reason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
