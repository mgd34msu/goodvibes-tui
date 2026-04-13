import type { AnyRuntimeEvent, RuntimeEventDomain, RuntimeEventEnvelope } from '../events/index.ts';
import type { UiEventFeed, UiRuntimeEvents } from '../ui-events.ts';

export interface TransportPaths {
  readonly baseUrl: string;
  readonly statusUrl: string;
  readonly controlPlaneUrl: string;
  readonly controlPlaneEventsUrl: string;
  readonly controlPlaneMethodsUrl: string;
  readonly sessionsUrl: string;
  readonly tasksUrl: string;
  readonly approvalsUrl: string;
  readonly providersUrl: string;
  readonly accountsUrl: string;
  readonly localAuthUrl: string;
  readonly remoteUrl: string;
  readonly remoteContractUrl: string;
  readonly peerRequestsUrl: string;
  readonly peerListUrl: string;
  readonly remoteWorkUrl: string;
}

export interface TransportJsonError {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;
}

export interface SerializedRuntimeEnvelope {
  readonly type: string;
  readonly timestamp?: number;
  readonly ts?: number;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly source?: string;
  readonly payload: unknown;
}

export type DomainEventConnector = (
  domain: RuntimeEventDomain,
  onEnvelope: (envelope: SerializedRuntimeEnvelope) => void,
) => void | Promise<() => void>;

const REMOTE_UI_DOMAINS: Record<keyof UiRuntimeEvents, RuntimeEventDomain> = {
  sessions: 'session',
  turns: 'turn',
  tools: 'tools',
  providers: 'providers',
  agents: 'agents',
  workflows: 'workflows',
  planner: 'planner',
  ops: 'ops',
};

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new Error('Transport baseUrl is required');
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function buildUrl(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${normalized}/`);
  return url.toString();
}

export function createTransportPaths(baseUrl: string): TransportPaths {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    baseUrl: normalized,
    statusUrl: buildUrl(normalized, '/status'),
    controlPlaneUrl: buildUrl(normalized, '/api/control-plane'),
    controlPlaneEventsUrl: buildUrl(normalized, '/api/control-plane/events'),
    controlPlaneMethodsUrl: buildUrl(normalized, '/api/control-plane/methods'),
    sessionsUrl: buildUrl(normalized, '/api/sessions'),
    tasksUrl: buildUrl(normalized, '/api/tasks'),
    approvalsUrl: buildUrl(normalized, '/api/approvals'),
    providersUrl: buildUrl(normalized, '/api/providers'),
    accountsUrl: buildUrl(normalized, '/api/accounts'),
    localAuthUrl: buildUrl(normalized, '/api/local-auth'),
    remoteUrl: buildUrl(normalized, '/api/remote'),
    remoteContractUrl: buildUrl(normalized, '/api/remote/node-host/contract'),
    peerRequestsUrl: buildUrl(normalized, '/api/remote/pair/requests'),
    peerListUrl: buildUrl(normalized, '/api/remote/peers'),
    remoteWorkUrl: buildUrl(normalized, '/api/remote/work'),
  };
}

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const error: TransportJsonError = {
      status: response.status,
      body,
      url,
    };
    throw Object.assign(new Error(`Transport request failed with status ${response.status} for ${url}`), {
      transport: error,
    });
  }
  return body as T;
}

export function createJsonInit(
  token: string | null | undefined,
  body?: unknown,
  method = 'GET',
): RequestInit {
  return {
    method,
    credentials: 'include',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

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

function toRuntimeEnvelope(envelope: SerializedRuntimeEnvelope): RuntimeEventEnvelope<string, AnyRuntimeEvent> {
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
    payload: envelope.payload as AnyRuntimeEvent,
  };
}

export function createRemoteUiRuntimeEvents(connect: DomainEventConnector): UiRuntimeEvents {
  function createFeed<TEvent extends AnyRuntimeEvent>(domain: RuntimeEventDomain): UiEventFeed<TEvent> {
    const payloadListeners = new Map<string, Set<(payload: TEvent) => void>>();
    const envelopeListeners = new Map<string, Set<(envelope: RuntimeEventEnvelope<string, TEvent>) => void>>();
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
        const payload = envelope.payload as TEvent;
        const typedEnvelope = toRuntimeEnvelope(envelope) as RuntimeEventEnvelope<string, TEvent>;
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
      if (hasListeners()) {
        return;
      }
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
      on<TType extends TEvent['type']>(
        type: TType,
        listener: (payload: Extract<TEvent, { type: TType }>) => void,
      ): () => void {
        const unsubscribe = addListener(payloadListeners, type, listener as (payload: TEvent) => void);
        maybeConnect();
        return () => {
          unsubscribe();
          maybeDisconnect();
        };
      },
      onEnvelope<TType extends TEvent['type']>(
        type: TType,
        listener: (envelope: RuntimeEventEnvelope<TType, Extract<TEvent, { type: TType }>>) => void,
      ): () => void {
        const unsubscribe = addListener(envelopeListeners, type, listener as (envelope: RuntimeEventEnvelope<string, TEvent>) => void);
        maybeConnect();
        return () => {
          unsubscribe();
          maybeDisconnect();
        };
      },
    };
  }

  return {
    sessions: createFeed(REMOTE_UI_DOMAINS.sessions),
    turns: createFeed(REMOTE_UI_DOMAINS.turns),
    tools: createFeed(REMOTE_UI_DOMAINS.tools),
    providers: createFeed(REMOTE_UI_DOMAINS.providers),
    agents: createFeed(REMOTE_UI_DOMAINS.agents),
    workflows: createFeed(REMOTE_UI_DOMAINS.workflows),
    planner: createFeed(REMOTE_UI_DOMAINS.planner),
    ops: createFeed(REMOTE_UI_DOMAINS.ops),
  };
}

export function buildEventSourceUrl(
  baseUrl: string,
  domain: RuntimeEventDomain,
): string {
  const url = new URL('/api/control-plane/events', `${normalizeBaseUrl(baseUrl)}/`);
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
  token: string | null | undefined,
  fetchImpl: typeof fetch,
): DomainEventConnector {
  return async (domain, onEnvelope) => {
    const url = buildEventSourceUrl(baseUrl, domain);
    const controller = new AbortController();
    const response = await fetchImpl(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(`Unable to connect transport event stream for ${domain}: ${response.status} ${body}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let data = '';
    const handleRecord = (): void => {
      if (!eventName || !data.trim()) {
        eventName = '';
        data = '';
        return;
      }
      if (eventName === domain) {
        try {
          onEnvelope(JSON.parse(data) as SerializedRuntimeEnvelope);
        } catch {
          // Ignore malformed event payloads; the daemon contract is line-oriented.
        }
      }
      eventName = '';
      data = '';
    };
    const consumeLine = (line: string): void => {
      if (!line) {
        handleRecord();
        return;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        return;
      }
      if (line.startsWith('data:')) {
        data += `${data ? '\n' : ''}${line.slice(5).trim()}`;
      }
    };
    const run = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const raw = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            consumeLine(raw);
            newlineIndex = buffer.indexOf('\n');
          }
        }
        if (buffer.trim()) {
          consumeLine(buffer.replace(/\r$/, ''));
          handleRecord();
        }
      } finally {
        controller.abort();
      }
    };
    void run().catch((error: unknown) => {
      if (!isExpectedDisconnectError(error)) {
        throw error;
      }
    });
    return () => {
      try {
        controller.abort();
      } catch (error) {
        if (!isExpectedDisconnectError(error)) {
          throw error;
        }
      }
    };
  };
}

export function createWebSocketConnector(
  baseUrl: string,
  token: string | null | undefined,
  WebSocketImpl: typeof WebSocket,
): DomainEventConnector {
  return async (domain, onEnvelope) => {
    const url = buildWebSocketUrl(baseUrl, [domain]);
    const socket = new WebSocketImpl(url);
    const onOpen = () => {
      if (!token) return;
      socket.send(JSON.stringify({
        type: 'auth',
        token,
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
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    return () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.close();
    };
  };
}
