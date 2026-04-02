/**
 * MCP server lifecycle span helpers.
 *
 * Tracks the full MCP server state machine:
 * MCP_CONFIGURED → MCP_CONNECTING → MCP_CONNECTED → MCP_DEGRADED
 * Terminal states: MCP_DISCONNECTED | MCP_AUTH_REQUIRED (when not reconnecting)
 *
 * One span per MCP server connection lifecycle.
 */
import type { Span, SpanAttributes } from '../types.ts';
import { SpanKind, SpanStatusCode } from '../types.ts';
import type { RuntimeTracer } from '../tracer.ts';

/** Context supplied when starting an MCP server lifecycle span. */
export interface McpSpanContext {
  /** MCP server ID. */
  readonly serverId: string;
  /** Transport type (e.g. 'stdio', 'sse', 'websocket'). */
  readonly transport: string;
  /** Optional server URL for network transports. */
  readonly url?: string;
  /** Trace ID for cross-span correlation. */
  readonly traceId: string;
}

/** Phase transitions that can be recorded on an MCP lifecycle span. */
export type McpPhase = 'connecting' | 'connected' | 'degraded' | 'auth_required' | 'reconnecting';

/** Result context supplied when ending an MCP lifecycle span. */
export interface McpSpanEndContext {
  /** Final outcome of the MCP server connection. */
  readonly outcome: 'connected' | 'disconnected' | 'auth_failed';
  /** Reason for disconnection if known. */
  readonly reason?: string;
  /** Whether a reconnect will be attempted. */
  readonly willRetry?: boolean;
  /** Number of tools available when connected. */
  readonly toolCount?: number;
  /** Number of resources available when connected. */
  readonly resourceCount?: number;
}

/**
 * Start an MCP server lifecycle span.
 *
 * @param tracer - RuntimeTracer instance.
 * @param ctx - Context from MCP_CONFIGURED event.
 */
export function startMcpSpan(tracer: RuntimeTracer, ctx: McpSpanContext): Span {
  const attrs: SpanAttributes = {
    'mcp.server_id': ctx.serverId,
    'mcp.transport': ctx.transport,
  };

  if (ctx.url !== undefined) {
    attrs['mcp.url'] = ctx.url;
  }

  return tracer.startSpan('mcp.lifecycle', {
    traceId: ctx.traceId,
    kind: SpanKind.CLIENT,
    attributes: attrs,
  });
}

/**
 * Record an MCP server phase transition event.
 *
 * @param span - The active MCP lifecycle span.
 * @param phase - The phase reached.
 * @param attrs - Optional additional attributes.
 */
export function recordMcpPhase(
  span: Span,
  phase: McpPhase,
  attrs?: SpanAttributes
): void {
  if (span.ended) return;
  span.addEvent(`mcp.${phase}`, attrs);
}

/**
 * End an MCP server lifecycle span.
 *
 * @param span - The span returned by `startMcpSpan`.
 * @param ctx - MCP lifecycle end context.
 */
export function endMcpSpan(span: Span, ctx: McpSpanEndContext): void {
  if (span.ended) return;

  span.setAttribute('mcp.outcome', ctx.outcome);

  if (ctx.toolCount !== undefined) {
    span.setAttribute('mcp.tool_count', ctx.toolCount);
  }
  if (ctx.resourceCount !== undefined) {
    span.setAttribute('mcp.resource_count', ctx.resourceCount);
  }
  if (ctx.willRetry !== undefined) {
    span.setAttribute('mcp.will_retry', ctx.willRetry);
  }

  span.addEvent(`mcp.${ctx.outcome}`);

  if (ctx.outcome === 'auth_failed') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'MCP authentication failed' });
  } else if (ctx.outcome === 'disconnected' && !ctx.willRetry) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: ctx.reason ?? 'MCP disconnected' });
    if (ctx.reason) {
      span.setAttribute('mcp.disconnect_reason', ctx.reason);
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}
