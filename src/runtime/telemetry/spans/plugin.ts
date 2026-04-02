/**
 * Plugin lifecycle span helpers.
 *
 * Tracks the full plugin state machine:
 * PLUGIN_DISCOVERED → PLUGIN_LOADING → PLUGIN_LOADED → PLUGIN_ACTIVE
 * Terminal states: PLUGIN_ERROR | PLUGIN_UNLOADING → PLUGIN_DISABLED
 *
 * One span per plugin lifecycle: starts on PLUGIN_DISCOVERED, ends on terminal state.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting a plugin lifecycle span. */
export interface PluginSpanContext {
  /** Plugin ID (unique identifier). */
  readonly pluginId: string;
  /** File system path to the plugin. */
  readonly path: string;
  /** Plugin version string. */
  readonly version: string;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
}

/** Phase transitions that can be recorded on a plugin lifecycle span. */
export type PluginPhase = 'loading' | 'loaded' | 'active' | 'degraded' | 'unloading';

/** Result context supplied when ending a plugin lifecycle span. */
export interface PluginSpanEndContext {
  /** Final outcome of the plugin lifecycle. */
  readonly outcome: 'active' | 'error' | 'disabled';
  /** Error description when outcome is 'error'. */
  readonly error?: string;
  /** Reason for disabling when outcome is 'disabled'. */
  readonly reason?: string;
  /** Capabilities registered by the plugin (populated on 'active'). */
  readonly capabilities?: string[];
}

/**
 * Start a plugin lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from PLUGIN_DISCOVERED event.
 */
export function startPluginSpan(tracer: RuntimeTracer, ctx: PluginSpanContext): Span {
  const attrs: SpanAttributes = {
    'plugin.id': ctx.pluginId,
    'plugin.path': ctx.path,
    'plugin.version': ctx.version,
  };

  return tracer.startSpan('plugin.lifecycle', {
    traceId: ctx.traceId,
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
}

/**
 * Record a plugin phase transition event on the active span.
 *
 * @param span - The active plugin lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes for this phase.
 */
export function recordPluginPhase(
  span: Span,
  phase: PluginPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`plugin.${phase}`, attrs);
}

/**
 * End a plugin lifecycle span.
 *
 * @param span - The span returned by `startPluginSpan`.
 * @param ctx - Plugin lifecycle end context.
 */
export function endPluginSpan(span: Span, ctx: PluginSpanEndContext): void {
  if (span.ended) return;

  span.setAttribute('plugin.outcome', ctx.outcome);

  if (ctx.capabilities !== undefined) {
    span.setAttribute('plugin.capability_count', ctx.capabilities.length);
  }

  span.addEvent(`plugin.${ctx.outcome}`);

  if (ctx.outcome === 'error' && ctx.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.error });
    span.setAttribute('plugin.error', ctx.error);
  } else if (ctx.outcome === 'disabled') {
    span.setStatus({ code: SpanStatusCode.OK });
    if (ctx.reason) {
      span.setAttribute('plugin.disable_reason', ctx.reason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
