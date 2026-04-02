/**
 * Health cascade span helpers.
 *
 * Creates point-in-time spans for each CASCADE_APPLIED event from the
 * health cascade engine. These are not lifecycle spans but event spans —
 * they start and end immediately to record the cascade effect in the trace.
 *
 * Health cascade spans are always root spans (no parent) since they are
 * cross-domain events that may span multiple domain lifecycles.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';
import type { CascadeAppliedEvent, CascadeEffect } from '../../health/types.ts';

/** Context supplied when recording a health cascade span. */
export interface HealthCascadeSpanContext {
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
  /** Optional parent span ID if the cascade is causally linked to a specific operation. */
  readonly parentSpanId?: string;
}

/**
 * Record a health cascade as a point-in-time span.
 *
 * Starts and immediately ends the span since the cascade is an instantaneous
 * event rather than an ongoing lifecycle. The span captures rule, source,
 * target, and effect details.
 *
 * @param tracer - RuntimeTracer instance.
 * @param event - The CASCADE_APPLIED event from the health engine.
 * @param ctx - Optional trace context for correlation.
 */
export function recordHealthCascadeSpan(
  tracer: RuntimeTracer,
  event: CascadeAppliedEvent,
  ctx?: HealthCascadeSpanContext
): Span {
  const effectAttrs = extractEffectAttributes(event.effect);

  const attrs: SpanAttributes = {
    'health.cascade.rule_id': event.ruleId,
    'health.cascade.source': event.source,
    'health.cascade.target': event.target,
    'health.cascade.effect_type': event.effect.type,
    'health.cascade.recovery_exhausted': event.recoveryExhausted,
    ...effectAttrs,
  };

  if (event.sourceContext !== undefined) {
    for (const [k, v] of Object.entries(event.sourceContext)) {
      attrs[`health.cascade.source_ctx.${k}`] = v;
    }
  }

  const span: Span = tracer.startSpan('health.cascade', {
    traceId: ctx?.traceId,
    parentSpanId: ctx?.parentSpanId,
    kind: SpanKind.INTERNAL,
    startTimeMs: event.timestamp,
    attributes: attrs,
  });

  span.addEvent('health.cascade_applied', {
    'health.cascade.rule_id': event.ruleId,
    'health.cascade.effect_type': event.effect.type,
  });

  // Cascade is treated as an error signal when recovery was exhausted
  if (event.recoveryExhausted) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Cascade after recovery exhausted: ${event.ruleId}`,
    });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end(event.timestamp);
  return span;
}

/** Extract flat SpanAttributes from a CascadeEffect variant. */
function extractEffectAttributes(effect: CascadeEffect): SpanAttributes {
  switch (effect.type) {
    case 'CANCEL_INFLIGHT':
      return { 'health.cascade.effect.scope': effect.scope };
    case 'BLOCK_DISPATCH':
      return {
        'health.cascade.effect.scope': effect.scope,
        'health.cascade.effect.queueable': effect.queueable,
      };
    case 'MARK_CHILDREN':
      return {
        'health.cascade.effect.status': effect.status,
        'health.cascade.effect.notify_parent': effect.notifyParent,
      };
    case 'DEREGISTER_TOOLS':
      return effect.pluginId !== undefined
        ? { 'health.cascade.effect.plugin_id': effect.pluginId }
        : {};
    case 'EMIT_EVENT':
      return { 'health.cascade.effect.event_type': effect.eventType };
    case 'BLOCK_NEW':
      return { 'health.cascade.effect.scope': effect.scope };
    default: {
      // Exhaustive check — TypeScript will error if a new variant is added without handling it
      const _exhaustive: never = effect;
      return {};
    }
  }
}
