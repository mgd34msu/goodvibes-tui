/**
 * DomainBridge — bridges RuntimeEventBus events to OTel span creation.
 *
 * Subscribes to all domain channels on the RuntimeEventBus and routes
 * lifecycle events to the appropriate span helper functions. Maintains
 * an active span map keyed by entity ID so that start events open spans
 * and terminal events close them with outcome context.
 *
 * Design principles:
 * - Span creation is purely observational — bridge failures must not
 *   affect the domain logic that emits events.
 * - All map lookups are safe — missing spans on terminal events are no-ops.
 * - The bridge is opt-in: calling `attach()` wires it; `detach()` unwires.
 */
import type { RuntimeEventBus } from '../../events/index.ts';
import type { RuntimeTracer } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/tracer';
import type { Span } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/types';
import type { CascadeAppliedEvent } from '@pellux/goodvibes-sdk/platform/runtime/health/types';
import { recordHealthCascadeSpan } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/health';
import { attachAgentDomain, attachCompactionDomain, attachPermissionDomain, attachSessionDomain } from './domain-bridge-agent-session.ts';
import { attachPluginDomain, attachMcpDomain } from './domain-bridge-plugin-mcp.ts';
import { type DomainBridgeHelpers, type SpanMap } from './domain-bridge-shared.ts';
import { attachTaskDomain, attachTransportDomain } from './domain-bridge-transport-task.ts';

/**
 * DomainBridge wires the RuntimeEventBus to the OTel span system.
 *
 * Usage:
 * ```ts
 * const bridge = new DomainBridge(tracer);
 * const detach = bridge.attach(bus);
 * // later:
 * detach();
 * ```
 */
export class DomainBridge {
  private readonly _tracer: RuntimeTracer;

  /** Active spans per domain, keyed by entity ID. */
  private readonly _pluginSpans: SpanMap = new Map();
  private readonly _mcpSpans: SpanMap = new Map();
  private readonly _transportSpans: SpanMap = new Map();
  private readonly _taskSpans: SpanMap = new Map();
  private readonly _agentSpans: SpanMap = new Map();
  private readonly _permissionSpans: SpanMap = new Map();
  private readonly _sessionSpans: SpanMap = new Map();
  private readonly _compactionSpans: SpanMap = new Map();

  constructor(tracer: RuntimeTracer) {
    this._tracer = tracer;
  }

  /**
   * Attach the bridge to the given event bus.
   *
   * Subscribes to all domain channels. Returns a cleanup function that
   * unsubscribes all listeners when called.
   *
   * @param bus - The RuntimeEventBus to subscribe to.
   * @returns A `detach` function that unsubscribes all domain listeners.
   */
  public attach(bus: RuntimeEventBus): () => void {
    const helpers = this._helpers();
    const unsubs: Array<() => void> = [
      attachPluginDomain({ bus, helpers }, this._pluginSpans),
      attachMcpDomain({ bus, helpers }, this._mcpSpans),
      attachTransportDomain({ bus, helpers }, this._transportSpans),
      attachTaskDomain({ bus, helpers }, this._taskSpans),
      attachAgentDomain({ bus, helpers }, this._agentSpans),
      attachPermissionDomain({ bus, helpers }, this._permissionSpans),
      attachSessionDomain({ bus, helpers }, this._sessionSpans),
      attachCompactionDomain({ bus, helpers }, this._compactionSpans),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }

  /**
   * Record a health cascade event as a point-in-time span.
   *
   * Called by the caller when CASCADE_APPLIED events are produced by the
   * CascadeEngine. The caller is responsible for providing the trace ID
   * from their current operational context.
   *
   * @param event - The CASCADE_APPLIED event.
   * @param traceId - Trace ID to use for correlation.
   */
  public recordCascade(event: CascadeAppliedEvent, traceId: string): void {
    this._safe(() => {
      recordHealthCascadeSpan(this._tracer, event, { traceId });
    });
  }

  private _safe(action: () => void): void {
    try {
      action();
    } catch {
      // Bridge failure must not propagate — non-fatal, swallowed intentionally
    }
  }

  private _withSpan(map: SpanMap, key: string, action: (span: Span) => void): void {
    const span = map.get(key);
    if (span) action(span);
  }

  private _closeSpan(map: SpanMap, key: string, action: (span: Span) => void): void {
    const span = map.get(key);
    if (!span) return;
    action(span);
    map.delete(key);
  }
  private _helpers(): DomainBridgeHelpers {
    return {
      tracer: this._tracer,
      safe: (action) => this._safe(action),
      withSpan: (map, key, action) => this._withSpan(map, key, action),
      closeSpan: (map, key, action) => this._closeSpan(map, key, action),
    };
  }
}
