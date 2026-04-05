/**
 * Events diagnostic panel data provider.
 *
 * Subscribes to ALL runtime event domains via the RuntimeEventBus and maintains
 * a bounded buffer of EventEntry records. Provides the typed event timeline
 * with full trace/session/turn/task/agent correlation context.
 *
 * This panel powers the "Events/Diagnostics" view.
 */
import type { RuntimeEventBus, EnvelopeListener } from '../../events/index.ts';
import type { AnyRuntimeEvent, RuntimeEventDomain } from '../../events/domain-map.ts';
import type { RuntimeEventEnvelope } from '../../events/envelope.ts';
import {
  type EventEntry,
  type DiagnosticFilter,
  type PanelConfig,
  DEFAULT_PANEL_CONFIG,
  appendBounded,
} from '../types.ts';

/** All domains observed by the events panel. */
const ALL_DOMAINS: readonly RuntimeEventDomain[] = [
  'session',
  'turn',
  'tools',
  'tasks',
  'agents',
  'permissions',
  'plugins',
  'mcp',
  'transport',
  'compaction',
  'ui',
];

/**
 * Produce a condensed human-readable summary of an event payload.
 * Extracts the most diagnostic fields without exposing full payloads.
 */
function summarizePayload(type: string, payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return type;
  const p = payload as Record<string, unknown>;
  // Extract common correlation fields for a concise summary line
  const parts: string[] = [];
  if (typeof p['tool'] === 'string') parts.push(`tool=${p['tool']}`);
  if (typeof p['callId'] === 'string') parts.push(`call=${p['callId'].slice(0, 8)}`);
  if (typeof p['agentId'] === 'string') parts.push(`agent=${p['agentId'].slice(0, 8)}`);
  if (typeof p['taskId'] === 'string') parts.push(`task=${p['taskId'].slice(0, 8)}`);
  if (typeof p['error'] === 'string') parts.push(`err=${p['error'].slice(0, 40)}`);
  if (typeof p['durationMs'] === 'number') parts.push(`${p['durationMs']}ms`);
  if (typeof p['progress'] === 'number') parts.push(`${p['progress']}%`);
  return parts.length > 0 ? `${type} ${parts.join(' ')}` : type;
}

/**
 * EventsPanel — diagnostic data provider for the full event timeline.
 *
 * Captures every envelope emitted across all domains, building a chronological
 * log with full tracing context. The buffer is bounded to prevent unbounded
 * memory growth in long-running sessions.
 */
export class EventsPanel {
  private readonly _config: PanelConfig;
  private readonly _eventBus: RuntimeEventBus;
  /** Monotonic sequence counter for ordering within a session. */
  private _seq = 0;
  /** Event history buffer (oldest first). */
  private readonly _buffer: EventEntry[] = [];
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Per-domain unsubscribe functions. */
  private readonly _unsubs: Array<() => void> = [];

  constructor(eventBus: RuntimeEventBus, config: PanelConfig = DEFAULT_PANEL_CONFIG) {
    this._eventBus = eventBus;
    this._config = config;
    this._start();
  }

  private _start(): void {
    for (const domain of ALL_DOMAINS) {
      const d = domain;
      const handler: EnvelopeListener<AnyRuntimeEvent> = (
        envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
      ) => {
        this._handleEnvelope(d, envelope);
      };
      const unsub = this._eventBus.onDomain(d, handler as EnvelopeListener);
      this._unsubs.push(unsub);
    }
  }

  private _handleEnvelope(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const entry: EventEntry = {
      seq: this._seq++,
      type: envelope.type,
      domain,
      ts: envelope.ts,
      traceId: envelope.traceId,
      sessionId: envelope.sessionId,
      turnId: envelope.turnId,
      agentId: envelope.agentId,
      taskId: envelope.taskId,
      source: envelope.source,
      summary: summarizePayload(envelope.type, envelope.payload),
    };
    appendBounded(this._buffer, entry, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Return a filtered snapshot of event timeline entries.
   * Ordered most-recent first.
   *
   * @param filter - Optional filter. Supports: domains (as `domains` strings),
   *   since/until time range, traceId/sessionId/turnId/taskId correlation,
   *   and limit.
   */
  public getSnapshot(filter?: DiagnosticFilter): EventEntry[] {
    let result = [...this._buffer];

    if (filter) {
      if (filter.domains && filter.domains.length > 0) {
        const domainSet = new Set(filter.domains);
        result = result.filter((e) => domainSet.has(e.domain));
      }
      if (filter.traceId !== undefined) {
        result = result.filter((e) => e.traceId === filter.traceId);
      }
      if (filter.sessionId !== undefined) {
        result = result.filter((e) => e.sessionId === filter.sessionId);
      }
      if (filter.turnId !== undefined) {
        result = result.filter((e) => e.turnId === filter.turnId);
      }
      if (filter.taskId !== undefined) {
        result = result.filter((e) => e.taskId === filter.taskId);
      }
      if (filter.since !== undefined) {
        const since = filter.since;
        result = result.filter((e) => e.ts >= since);
      }
      if (filter.until !== undefined) {
        const until = filter.until;
        result = result.filter((e) => e.ts <= until);
      }
    }

    // Most recent first
    result.reverse();

    const limit = filter?.limit ?? this._config.bufferLimit;
    return result.slice(0, limit);
  }

  /**
   * Register a callback invoked whenever a new event is captured.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all event bus subscriptions and clear internal state.
   */
  public dispose(): void {
    for (const unsub of this._unsubs) {
      unsub();
    }
    this._unsubs.length = 0;
    this._subscribers.clear();
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Non-fatal: subscriber errors must not crash the provider
      }
    }
  }
}
