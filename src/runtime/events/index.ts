/**
 * Runtime Events — barrel re-exports and RuntimeEventBus.
 *
 * Import from this module to access the typed event system:
 * ```ts
 * import { RuntimeEventBus, createEventEnvelope } from '../runtime/events/index.ts';
 * ```
 */
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { AnyRuntimeEvent, RuntimeEventDomain, DomainEventMap } from './domain-map.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export type { RuntimeEventEnvelope, EnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
export { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
export type { SessionEvent, SessionEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/session';
export type { TurnEvent, TurnEventType } from './turn.ts';
export type { ProviderEvent, ProviderEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/providers';
export type { ToolEvent, ToolEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/tools';
export type { TaskEvent, TaskEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/tasks';
export type { AgentEvent, AgentEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/agents';
export type { WorkflowEvent, WorkflowEventType } from './workflows.ts';
export type { OrchestrationEvent, OrchestrationEventType, OrchestrationTaskContract } from '@pellux/goodvibes-sdk/platform/runtime/events/orchestration';
export type { CommunicationEvent, CommunicationEventType, CommunicationKind, CommunicationScope } from '@pellux/goodvibes-sdk/platform/runtime/events/communication';
export type { PlannerEvent, PlannerEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/planner';
export type { PermissionEvent, PermissionEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/permissions';
export type { PluginEvent, PluginEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/plugins';
export type { McpEvent, McpEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/mcp';
export type { TransportEvent, TransportEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/transport';
export type { CompactionEvent, CompactionEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/compaction';
export type { UIEvent, UIEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/ui';
export type { OpsEvent, OpsEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/ops';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './domain-map.ts';
export type { AnyRuntimeEvent, RuntimeEventPayload, RuntimeEventDomain, DomainEventMap } from './domain-map.ts';
export type { AutomationEvent, AutomationEventType, AutomationScheduleKind, AutomationExecutionMode, AutomationRunOutcome } from '@pellux/goodvibes-sdk/platform/runtime/events/automation';
export { AUTOMATION_SCHEDULE_KINDS, AUTOMATION_RUN_OUTCOMES } from '@pellux/goodvibes-sdk/platform/runtime/events/automation';
export type { RouteEvent, RouteEventType, RouteSurfaceKind, RouteTargetKind } from '@pellux/goodvibes-sdk/platform/runtime/events/routes';
export { ROUTE_SURFACE_KINDS, ROUTE_TARGET_KINDS } from '@pellux/goodvibes-sdk/platform/runtime/events/routes';
export type { ControlPlaneEvent, ControlPlaneEventType, ControlPlaneClientKind, ControlPlaneTransportKind, ControlPlanePrincipalKind } from '@pellux/goodvibes-sdk/platform/runtime/events/control-plane';
export { CONTROL_PLANE_CLIENT_KINDS, CONTROL_PLANE_TRANSPORT_KINDS, CONTROL_PLANE_PRINCIPAL_KINDS } from '@pellux/goodvibes-sdk/platform/runtime/events/control-plane';
export type { DeliveryEvent, DeliveryEventType, DeliveryKind } from '@pellux/goodvibes-sdk/platform/runtime/events/deliveries';
export { DELIVERY_KINDS } from '@pellux/goodvibes-sdk/platform/runtime/events/deliveries';
export type { WatcherEvent, WatcherEventType, WatcherSourceKind } from '@pellux/goodvibes-sdk/platform/runtime/events/watchers';
export { WATCHER_SOURCE_KINDS } from '@pellux/goodvibes-sdk/platform/runtime/events/watchers';
export type { SurfaceEvent, SurfaceEventType, SurfaceKind } from '@pellux/goodvibes-sdk/platform/runtime/events/surfaces';
export { SURFACE_KINDS } from '@pellux/goodvibes-sdk/platform/runtime/events/surfaces';
export type { KnowledgeEvent, KnowledgeEventType } from '@pellux/goodvibes-sdk/platform/runtime/events/knowledge';

/** Listener callback receiving a fully-formed envelope. */
export type EnvelopeListener<T extends AnyRuntimeEvent = AnyRuntimeEvent> = (
  envelope: RuntimeEventEnvelope<T['type'], T>
) => void;

/**
 * Maximum listeners per channel before a potential memory leak warning is emitted.
 *
 * 100 is a generous threshold for a single event type or domain; normal usage
 * rarely exceeds single-digit listeners. Exceeding this strongly suggests a
 * subscriber is being registered without a corresponding unsubscribe.
 */
const MAX_LISTENERS = 100;

/**
 * RuntimeEventBus — typed event bus for domain-structured runtime events.
 *
 * Supports two subscription modes:
 * - `on(eventType, callback)` — subscribe to a specific event type
 * - `onDomain(domain, callback)` — subscribe to all events in a domain
 *
 * All events are wrapped in a RuntimeEventEnvelope providing traceId,
 * sessionId, timestamps, and source context.
 *
 * This is the authoritative event transport for runtime domain signaling.
 */
export class RuntimeEventBus {
  /** Per-event-type listener sets. Keyed by the exact event type string. */
  private readonly _listeners = new Map<AnyRuntimeEvent['type'], Set<EnvelopeListener>>();
  /** Per-domain listener sets. Keyed by RuntimeEventDomain. */
  private readonly _domainListeners = new Map<RuntimeEventDomain, Set<EnvelopeListener>>();

  /**
   * Subscribe to a specific event type.
   *
   * @param eventType - The exact event type string to listen for.
   * @param callback - Called with the full envelope on each emission.
   * @returns An unsubscribe function.
   */
  public on<T extends AnyRuntimeEvent>(
    eventType: T['type'],
    callback: EnvelopeListener<T>
  ): () => void {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    const set = this._listeners.get(eventType)!;
    set.add(callback as EnvelopeListener);
    if (set.size > MAX_LISTENERS) {
      logger.warn('[RuntimeEventBus] possible listener leak detected', {
        eventType,
        count: set.size,
        max: MAX_LISTENERS,
      });
    }
    return () => this._off(eventType, callback as EnvelopeListener);
  }

  /**
   * Subscribe to all events in a named domain.
   *
   * @param domain - Domain name (e.g. 'turn', 'tools', 'session').
   * @param callback - Called with the full envelope for each domain event.
   * @returns An unsubscribe function.
   */
  public onDomain<D extends RuntimeEventDomain>(
    domain: D,
    callback: EnvelopeListener<DomainEventMap[D]>
  ): () => void {
    if (!this._domainListeners.has(domain)) {
      this._domainListeners.set(domain, new Set());
    }
    const set = this._domainListeners.get(domain)!;
    set.add(callback as EnvelopeListener);
    if (set.size > MAX_LISTENERS) {
      logger.warn('[RuntimeEventBus] possible domain listener leak detected', {
        domain,
        count: set.size,
        max: MAX_LISTENERS,
      });
    }
    return () => this._offDomain(domain, callback as EnvelopeListener);
  }

  /**
   * Emit a runtime event envelope to all matching per-type and per-domain subscribers.
   *
   * @internal Callers MUST use the typed emitter wrapper functions from
   * `src/runtime/emitters/` rather than calling this method directly.
   * Direct usage bypasses domain-event type enforcement: TypeScript cannot
   * statically link the `domain` argument to the `envelope` payload type due
   * to union complexity limitations (TS2590), meaning mismatched pairs compile
   * without error.
   *
   * @see emitTurnSubmitted, emitToolReceived, etc. in `src/runtime/emitters/`
   *
   * @param domain - Domain this event belongs to.
   * @param envelope - The fully-formed envelope to dispatch.
   */
  public emit(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    // Dispatch to per-type listeners
    const typeSet = this._listeners.get(envelope.type);
    if (typeSet) {
      for (const handler of typeSet) {
        try {
          handler(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
        } catch (err) {
          logger.error('[RuntimeEventBus] listener error', {
            eventType: envelope.type,
            error: summarizeError(err),
          });
        }
      }
    }
    // Dispatch to per-domain listeners
    const domainSet = this._domainListeners.get(domain);
    if (domainSet) {
      for (const handler of domainSet) {
        try {
          handler(envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
        } catch (err) {
          logger.error('[RuntimeEventBus] domain listener error', {
            domain,
            eventType: envelope.type,
            error: summarizeError(err),
          });
        }
      }
    }
  }

  private _off(eventType: AnyRuntimeEvent['type'], callback: EnvelopeListener): void {
    const set = this._listeners.get(eventType);
    set?.delete(callback);
    if (set?.size === 0) this._listeners.delete(eventType);
  }

  private _offDomain(domain: RuntimeEventDomain, callback: EnvelopeListener): void {
    const set = this._domainListeners.get(domain);
    set?.delete(callback);
    if (set?.size === 0) this._domainListeners.delete(domain);
  }
}
