import type { RuntimeEventDomain } from '../events/index.ts';
import { RUNTIME_EVENT_DOMAINS } from '../events/domain-map.ts';
import { resolveAuthToken, type AuthTokenResolver } from './http-auth.ts';
import { buildUrl, normalizeBaseUrl } from './transport-paths.ts';
import { openServerSentEventStream } from './sse-stream.ts';
import type { StreamReconnectPolicy } from './stream-reconnect.ts';
import {
  createRemoteDomainEvents,
  type DomainEventConnector,
  type DomainEvents,
  type SerializedEventEnvelope,
} from './domain-events.ts';

type RuntimeEventRecord = { readonly type: string };

export type SerializedRuntimeEnvelope<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  SerializedEventEnvelope<TEvent>;

export type RemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  DomainEvents<RuntimeEventDomain, TEvent>;

export interface RuntimeEventConnectorOptions {
  readonly reconnect?: StreamReconnectPolicy;
  readonly onError?: (error: unknown) => void;
}

type AuthTokenSource = string | null | undefined | AuthTokenResolver;

async function resolveAuthTokenSource(source: AuthTokenSource): Promise<string | null> {
  if (typeof source === 'function') {
    return await resolveAuthToken(null, source);
  }
  return source ?? null;
}

export function createRemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  connect: DomainEventConnector<RuntimeEventDomain, TEvent>,
): RemoteRuntimeEvents<TEvent> {
  return createRemoteDomainEvents(
    RUNTIME_EVENT_DOMAINS,
    connect,
  );
}

export function buildEventSourceUrl(
  baseUrl: string,
  domain: RuntimeEventDomain,
): string {
  const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', domain);
  return url.toString();
}

export function buildWebSocketUrl(
  baseUrl: string,
  domains: readonly RuntimeEventDomain[],
): string {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL('/api/control-plane/ws', base.replace(/^http(s?):\/\//, 'ws$1://'));
  url.searchParams.set('clientKind', 'web');
  if (domains.length > 0) {
    url.searchParams.set('domains', domains.join(','));
  }
  return url.toString();
}

export function createEventSourceConnector(
  baseUrl: string,
  token: AuthTokenSource,
  fetchImpl: typeof fetch,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, RuntimeEventRecord> {
  const handleError = options.onError ?? (options.reconnect?.enabled ? (() => {}) : undefined);
  return async (domain, onEnvelope) => {
    const url = buildEventSourceUrl(baseUrl, domain);
    return await openServerSentEventStream(fetchImpl, url, {
      onEvent: (eventName, payload) => {
        if (eventName !== domain) return;
        if (!payload || typeof payload !== 'object') return;
        onEnvelope(payload as SerializedRuntimeEnvelope);
      },
      onError: handleError,
    }, {
      reconnect: options.reconnect,
      getAuthToken: typeof token === 'function' ? token : undefined,
      authToken: typeof token === 'function' ? null : token,
    });
  };
}

export function createWebSocketConnector(
  baseUrl: string,
  token: AuthTokenSource,
  WebSocketImpl: typeof WebSocket,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, RuntimeEventRecord> {
  return async (domain, onEnvelope) => {
    const url = buildWebSocketUrl(baseUrl, [domain]);
    const reconnect = options.reconnect;
    const enabled = reconnect?.enabled ?? false;
    let stopped = false;
    let reconnectAttempt = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const closeSocket = () => {
      if (!socket) return;
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      socket.close();
      socket = null;
    };

    const scheduleReconnect = () => {
      if (!enabled || stopped) return;
      const nextAttempt = reconnectAttempt + 1;
      const maxAttempts = reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY;
      if (nextAttempt >= maxAttempts) return;
      reconnectAttempt = nextAttempt;
      const baseDelayMs = reconnect?.baseDelayMs ?? 500;
      const maxDelayMs = reconnect?.maxDelayMs ?? 5_000;
      const backoffFactor = reconnect?.backoffFactor ?? 2;
      const delayMs = Math.min(maxDelayMs, Math.floor(baseDelayMs * (backoffFactor ** Math.max(0, nextAttempt - 1))));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
    };

    const onOpen = async () => {
      reconnectAttempt = 0;
      const authToken = await resolveAuthTokenSource(token);
      if (!authToken || !socket) return;
      socket.send(JSON.stringify({
        type: 'auth',
        token: authToken,
        domains: [domain],
      }));
    };

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string; event?: string; payload?: unknown };
        if (frame.type === 'event' && frame.event === domain && frame.payload && typeof frame.payload === 'object') {
          onEnvelope(frame.payload as SerializedRuntimeEnvelope);
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    const onClose = () => {
      closeSocket();
      scheduleReconnect();
    };

    const onError = (event: Event) => {
      options.onError?.(event);
    };

    const connect = async () => {
      if (stopped) return;
      closeSocket();
      const nextSocket = new WebSocketImpl(url);
      socket = nextSocket;
      nextSocket.addEventListener('open', onOpen);
      nextSocket.addEventListener('message', onMessage);
      nextSocket.addEventListener('close', onClose);
      nextSocket.addEventListener('error', onError);
    };

    await connect();
    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      closeSocket();
    };
  };
}
