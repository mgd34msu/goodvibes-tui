/**
 * Runtime Events — barrel re-exports and RuntimeEventBus.
 *
 * Import from this module to access the typed event system:
 * ```ts
 * import { RuntimeEventBus, createEventEnvelope } from '../runtime/events/index.ts';
 * ```
 */
import { logger } from '../../utils/logger.ts';
import type { RuntimeEventEnvelope } from './envelope.ts';
import type { AnyRuntimeEvent, RuntimeEventDomain, DomainEventMap } from './domain-map.ts';

export type { RuntimeEventEnvelope, EnvelopeContext } from './envelope.ts';
export { createEventEnvelope } from './envelope.ts';
export type { SessionEvent, SessionEventType } from './session.ts';
export type { TurnEvent, TurnEventType } from './turn.ts';
export type { ProviderEvent, ProviderEventType } from './providers.ts';
export type { ToolEvent, ToolEventType } from './tools.ts';
export type { TaskEvent, TaskEventType } from './tasks.ts';
export type { AgentEvent, AgentEventType } from './agents.ts';
export type { WorkflowEvent, WorkflowEventType } from './workflows.ts';
export type { OrchestrationEvent, OrchestrationEventType, OrchestrationTaskContract } from './orchestration.ts';
export type { CommunicationEvent, CommunicationEventType, CommunicationKind, CommunicationScope } from './communication.ts';
export type { PlannerEvent, PlannerEventType } from './planner.ts';
export type { PermissionEvent, PermissionEventType } from './permissions.ts';
export type { PluginEvent, PluginEventType } from './plugins.ts';
export type { McpEvent, McpEventType } from './mcp.ts';
export type { TransportEvent, TransportEventType } from './transport.ts';
export type { CompactionEvent, CompactionEventType } from './compaction.ts';
export type { UIEvent, UIEventType } from './ui.ts';
export type { OpsEvent, OpsEventType } from './ops.ts';
export type { AnyRuntimeEvent, RuntimeEventPayload, RuntimeEventDomain, DomainEventMap } from './domain-map.ts';

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
            error: err instanceof Error ? err.message : String(err),
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
            error: err instanceof Error ? err.message : String(err),
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
