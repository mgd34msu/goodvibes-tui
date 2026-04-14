import type { EventEnvelope } from '../event-envelope.ts';
import { createRuntimeEventFeeds, type RuntimeEventFeed, type RuntimeEventFeeds } from '../event-feeds.ts';

type EventLike = { readonly type: string };

export interface SerializedEventEnvelope<TEvent extends EventLike = EventLike> {
  readonly type: string;
  readonly timestamp?: number;
  readonly ts?: number;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly source?: string;
  readonly payload: TEvent;
}

export type DomainEventConnector<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = (
  domain: TDomain,
  onEnvelope: (envelope: SerializedEventEnvelope<TEvent>) => void,
) => void | Promise<() => void>;

export type DomainEvents<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = RuntimeEventFeeds<TDomain, TEvent>;

function addListener<T>(map: Map<string, Set<T>>, type: string, listener: T): () => void {
  const listeners = map.get(type) ?? new Set<T>();
  listeners.add(listener);
  map.set(type, listeners);
  return () => {
    const existing = map.get(type);
    if (!existing) return;
    existing.delete(listener);
    if (existing.size === 0) {
      map.delete(type);
    }
  };
}

function hasAnyListener(map: Map<string, Set<unknown>>): boolean {
  for (const listeners of map.values()) {
    if (listeners.size > 0) return true;
  }
  return false;
}

function isExpectedDisconnectError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: string }).name === 'AbortError'
  );
}

function toEventEnvelope<TEvent extends EventLike>(
  envelope: SerializedEventEnvelope<TEvent>,
): EventEnvelope<string, TEvent> {
  return {
    type: envelope.type,
    ts: typeof envelope.ts === 'number'
      ? envelope.ts
      : typeof envelope.timestamp === 'number'
        ? envelope.timestamp
        : Date.now(),
    traceId: typeof envelope.traceId === 'string' ? envelope.traceId : 'transport-trace',
    sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : 'transport',
    source: typeof envelope.source === 'string' ? envelope.source : 'transport',
    payload: envelope.payload,
  };
}

function createRemoteDomainEventFeed<
  TDomain extends string,
  TEvent extends EventLike,
>(
  domain: TDomain,
  connect: DomainEventConnector<TDomain, TEvent>,
): RuntimeEventFeed<TEvent> {
  const payloadListeners = new Map<string, Set<(payload: TEvent) => void>>();
  const envelopeListeners = new Map<string, Set<(envelope: EventEnvelope<string, TEvent>) => void>>();
  let disconnect: (() => void) | null = null;
  let connectPromise: Promise<void> | null = null;
  let disconnectPending = false;

  const hasListeners = (): boolean => (
    hasAnyListener(payloadListeners as Map<string, Set<unknown>>)
    || hasAnyListener(envelopeListeners as Map<string, Set<unknown>>)
  );

  const maybeConnect = (): void => {
    if (disconnect || connectPromise) return;
    connectPromise = Promise.resolve(connect(domain, (envelope) => {
      const eventType = typeof envelope.type === 'string' ? envelope.type : '';
      if (!eventType) return;
      const payload = envelope.payload;
      const typedEnvelope = toEventEnvelope(envelope);
      for (const listener of payloadListeners.get(eventType) ?? []) {
        listener(payload);
      }
      for (const listener of envelopeListeners.get(eventType) ?? []) {
        listener(typedEnvelope);
      }
    })).then((cleanup) => {
      if (typeof cleanup !== 'function') return;
      if (disconnectPending && !hasListeners()) {
        cleanup();
        return;
      }
      disconnect = cleanup;
    }).catch((error: unknown) => {
      if (!isExpectedDisconnectError(error)) {
        throw error;
      }
    }).finally(() => {
      connectPromise = null;
      disconnectPending = false;
    });
  };

  const maybeDisconnect = (): void => {
    if (hasListeners()) return;
    if (disconnect) {
      disconnect();
      disconnect = null;
      return;
    }
    if (connectPromise) {
      disconnectPending = true;
    }
  };

  return {
    on(type, listener) {
      const unsubscribe = addListener(payloadListeners, type, listener as (payload: TEvent) => void);
      maybeConnect();
      return () => {
        unsubscribe();
        maybeDisconnect();
      };
    },
    onEnvelope(type, listener) {
      const unsubscribe = addListener(envelopeListeners, type, listener as (envelope: EventEnvelope<string, TEvent>) => void);
      maybeConnect();
      return () => {
        unsubscribe();
        maybeDisconnect();
      };
    },
  };
}

export function createRemoteDomainEvents<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
>(
  domains: readonly TDomain[],
  connect: DomainEventConnector<TDomain, TEvent>,
): DomainEvents<TDomain, TEvent> {
  return createRuntimeEventFeeds(
    domains,
    (domain) => createRemoteDomainEventFeed(domain, connect),
  );
}
