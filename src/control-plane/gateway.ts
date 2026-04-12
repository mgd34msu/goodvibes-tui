import { randomUUID } from 'node:crypto';
import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeEventBus, RuntimeEventDomain, RuntimeEventEnvelope, AnyRuntimeEvent } from '../runtime/events/index.ts';
import type { ControlPlaneClientRecord } from '../runtime/store/domains/control-plane.ts';
import {
  emitControlPlaneAuthGranted,
  emitControlPlaneClientConnected,
  emitControlPlaneClientDisconnected,
  emitControlPlaneSubscriptionCreated,
  emitControlPlaneSubscriptionDropped,
} from '../runtime/emitters/index.ts';
import { renderControlPlaneGatewayWebUi } from './gateway-web-ui.ts';
import type {
  ControlPlaneClientDescriptor,
  ControlPlaneServerConfig,
  ControlPlaneSurfaceMessage,
} from './types.ts';

const DEFAULT_DOMAINS: readonly RuntimeEventDomain[] = [
  'session',
  'tasks',
  'agents',
  'automation',
  'routes',
  'control-plane',
  'deliveries',
  'surfaces',
  'watchers',
  'transport',
  'ops',
  'knowledge',
];

const DEFAULT_SERVER_CONFIG: ControlPlaneServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 3421,
  streamingMode: 'sse',
  sessionTtlMs: 12 * 60 * 60 * 1000,
};

export interface ControlPlaneGatewayConfig {
  readonly runtimeBus?: RuntimeEventBus | null;
  readonly runtimeStore?: RuntimeStore | null;
  readonly server?: Partial<ControlPlaneServerConfig>;
}

export interface ControlPlaneEventStreamOptions {
  readonly clientId?: string;
  readonly clientKind?:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly transport?: 'local' | 'http' | 'sse' | 'ws' | 'webhook';
  readonly label?: string;
  readonly domains?: readonly RuntimeEventDomain[];
  readonly principalId?: string;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token';
  readonly scopes?: readonly string[];
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceId?: string;
  readonly remoteAddress?: string;
  readonly capabilities?: readonly string[];
}

export interface ControlPlaneRecentEvent {
  readonly id: string;
  readonly event: string;
  readonly createdAt: number;
  readonly payload: unknown;
}

interface LiveControlPlaneClient {
  readonly clientId: string;
  readonly kind:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly surfaceId?: string;
  readonly routeId?: string;
  readonly send: (event: string, payload: unknown) => void;
}

interface WebSocketControlPlaneClient {
  readonly clientId: string;
  readonly traceId: string;
  readonly domains: Set<RuntimeEventDomain>;
  readonly unsubscribers: Map<RuntimeEventDomain, () => void>;
}

function serializeEnvelope(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    type: envelope.type,
    timestamp: envelope.ts,
    traceId: envelope.traceId,
    sessionId: envelope.sessionId,
    source: envelope.source,
    payload: envelope.payload,
  };
}

function toClientDescriptor(record: ControlPlaneClientRecord): ControlPlaneClientDescriptor {
  return {
    id: record.id,
    surface: record.kind,
    label: record.label,
    connectedAt: record.authenticatedAt ?? record.lastSeenAt ?? Date.now(),
    lastSeenAt: record.lastSeenAt ?? Date.now(),
    ...(record.metadata.userId && typeof record.metadata.userId === 'string' ? { userId: record.metadata.userId } : {}),
  };
}

export class ControlPlaneGateway {
  private runtimeBus: RuntimeEventBus | null;
  private dispatch: DomainDispatch | null;
  private readonly serverConfig: ControlPlaneServerConfig;
  private readonly clients = new Map<string, ControlPlaneClientRecord>();
  private readonly liveClients = new Map<string, LiveControlPlaneClient>();
  private readonly websocketClients = new Map<string, WebSocketControlPlaneClient>();
  private readonly recentMessages: ControlPlaneSurfaceMessage[] = [];
  private readonly recentEvents: ControlPlaneRecentEvent[] = [];
  private requestCount = 0;
  private errorCount = 0;
  private lastRequestAt: number | undefined;

  constructor(config: ControlPlaneGatewayConfig = {}) {
    this.runtimeBus = config.runtimeBus ?? null;
    this.dispatch = config.runtimeStore ? createDomainDispatch(config.runtimeStore) : null;
    this.serverConfig = {
      ...DEFAULT_SERVER_CONFIG,
      ...config.server,
    };
    if (this.dispatch) {
      this.dispatch.syncControlPlaneState({
        enabled: this.serverConfig.enabled,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: this.serverConfig.enabled ? 'disconnected' : 'disabled',
      }, 'control-plane.gateway.init');
    }
  }

  attachRuntime(config: {
    readonly runtimeBus?: RuntimeEventBus | null;
    readonly runtimeStore?: RuntimeStore | null;
  }): void {
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
    if (config.runtimeStore) {
      this.dispatch = createDomainDispatch(config.runtimeStore);
      this.dispatch.syncControlPlaneState({
        enabled: this.serverConfig.enabled,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: this.serverConfig.enabled ? 'disconnected' : 'disabled',
      }, 'control-plane.gateway.attach');
      for (const client of this.clients.values()) {
        this.dispatch.syncControlPlaneClient(client, 'control-plane.gateway.attach');
      }
    }
  }

  listClients(): ControlPlaneClientDescriptor[] {
    return [...this.clients.values()]
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id))
      .map(toClientDescriptor);
  }

  getSnapshot(): Record<string, unknown> {
    const active = [...this.clients.values()].filter((client) => client.connected);
    return {
      server: this.serverConfig,
      totals: {
        clients: this.clients.size,
        activeClients: active.length,
        surfaceMessages: this.recentMessages.length,
        recentEvents: this.recentEvents.length,
        requests: this.requestCount,
        errors: this.errorCount,
      },
      clients: this.listClients(),
      messages: this.listSurfaceMessages(20),
      recentEvents: this.listRecentEvents(30),
    };
  }

  listSurfaceMessages(limit = 50): ControlPlaneSurfaceMessage[] {
    return this.recentMessages.slice(0, Math.max(1, limit));
  }

  listRecentEvents(limit = 100): ControlPlaneRecentEvent[] {
    return this.recentEvents.slice(0, Math.max(1, limit));
  }

  publishSurfaceMessage(input: Omit<ControlPlaneSurfaceMessage, 'id' | 'createdAt'>): ControlPlaneSurfaceMessage {
    const message: ControlPlaneSurfaceMessage = {
      id: `cpmsg-${randomUUID().slice(0, 8)}`,
      createdAt: Date.now(),
      ...input,
    };
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > 200) {
      this.recentMessages.length = 200;
    }
    for (const client of this.liveClients.values()) {
      if (client.kind !== 'web') continue;
      if (message.clientId && client.clientId !== message.clientId) continue;
      if (message.routeId && client.routeId && client.routeId !== message.routeId) continue;
      if (message.surfaceId && client.surfaceId && client.surfaceId !== message.surfaceId) continue;
      client.send('surface-message', message);
    }
    this.rememberEvent('surface-message', message);
    return message;
  }

  publishEvent(event: string, payload: unknown, filter?: {
    readonly clientKind?: LiveControlPlaneClient['kind'];
    readonly clientId?: string;
    readonly routeId?: string;
    readonly surfaceId?: string;
  }): void {
    this.rememberEvent(event, payload);
    for (const client of this.liveClients.values()) {
      if (filter?.clientKind && client.kind !== filter.clientKind) continue;
      if (filter?.clientId && client.clientId !== filter.clientId) continue;
      if (filter?.routeId && client.routeId && client.routeId !== filter.routeId) continue;
      if (filter?.surfaceId && client.surfaceId && client.surfaceId !== filter.surfaceId) continue;
      client.send(event, payload);
    }
  }

  recordApiRequest(input: {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly clientKind?: ControlPlaneEventStreamOptions['clientKind'];
    readonly error?: string;
  }): void {
    this.requestCount += 1;
    this.lastRequestAt = Date.now();
    if (input.status >= 400 || input.error) {
      this.errorCount += 1;
    }
    this.dispatch?.syncControlPlaneState({
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
      ...(input.error ? { lastError: input.error } : {}),
    }, 'control-plane.gateway.api-request');
    this.rememberEvent('api-request', {
      method: input.method,
      path: input.path,
      status: input.status,
      clientKind: input.clientKind ?? 'web',
      ...(input.error ? { error: input.error } : {}),
    });
  }

  setServerState(patch: Partial<ControlPlaneServerConfig>): void {
    Object.assign(this.serverConfig, patch);
    const hasActiveClient = [...this.clients.values()].some((client) => client.connected);
    this.dispatch?.syncControlPlaneState({
      enabled: this.serverConfig.enabled,
      host: this.serverConfig.host,
      port: this.serverConfig.port,
      connectionState: this.serverConfig.enabled ? (hasActiveClient ? 'connected' : 'disconnected') : 'disabled',
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
    }, 'control-plane.gateway.state');
  }

  openWebSocketClient(
    options: ControlPlaneEventStreamOptions,
    send: (event: string, payload: unknown) => void,
  ): { clientId: string; domains: readonly RuntimeEventDomain[] } {
    if (!this.runtimeBus) {
      throw new Error('Runtime event bus unavailable');
    }

    const selectedDomains = options.domains?.length ? [...options.domains] : [...DEFAULT_DOMAINS];
    const clientId = options.clientId ?? `cp-${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.clientKind ?? 'web'}:${clientId}`;
    const now = Date.now();
    const surfaceKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    const clientRecord: ControlPlaneClientRecord = {
      id: clientId,
      kind: surfaceKind,
      label,
      transport: 'websocket',
      connected: true,
      sessionId: options.sessionId,
      routeId: options.routeId,
      surfaceId: options.surfaceId,
      authenticatedAt: now,
      lastSeenAt: now,
      remoteAddress: options.remoteAddress,
      capabilities: [...(options.capabilities ?? [])],
      metadata: {
        domains: selectedDomains,
        ...(options.principalId ? { userId: options.principalId } : {}),
      },
    };
    const traceId = `control-plane:${clientId}`;
    this.clients.set(clientId, clientRecord);
    this.liveClients.set(clientId, {
      clientId,
      kind: options.clientKind ?? 'web',
      surfaceId: options.surfaceId,
      routeId: options.routeId,
      send,
    });
    this.websocketClients.set(clientId, {
      clientId,
      traceId,
      domains: new Set(),
      unsubscribers: new Map(),
    });
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: 'connected',
    }, 'control-plane.gateway.ws-connect');
    this.dispatch?.syncControlPlaneClient(clientRecord, 'control-plane.gateway.ws-connect');

    const eventClientKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    emitControlPlaneClientConnected(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      clientKind: eventClientKind,
      transport: 'ws',
    });
    emitControlPlaneSubscriptionCreated(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      subscriptionId: clientId,
      topics: selectedDomains,
    });
    if (options.principalId) {
      emitControlPlaneAuthGranted(this.runtimeBus, {
        sessionId: options.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId,
      }, {
        clientId,
        principalId: options.principalId,
        principalKind: options.principalKind ?? 'token',
        scopes: [...(options.scopes ?? ['read:events'])],
      });
    }

    this.subscribeWebSocketClient(clientId, selectedDomains);
    send('ready', { clientId, domains: selectedDomains, transport: 'websocket' });
    this.replayRecentTraffic(send);
    return { clientId, domains: selectedDomains };
  }

  touchWebSocketClient(clientId: string, metadata: Record<string, unknown> = {}): void {
    const existing = this.clients.get(clientId);
    if (!existing) return;
    const updated: ControlPlaneClientRecord = {
      ...existing,
      lastSeenAt: Date.now(),
      metadata: {
        ...existing.metadata,
        ...metadata,
      },
    };
    this.clients.set(clientId, updated);
    this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.ws-touch');
  }

  authenticateClient(clientId: string, input: {
    readonly principalId: string;
    readonly principalKind?: 'user' | 'bot' | 'service' | 'token';
    readonly scopes?: readonly string[];
    readonly label?: string;
    readonly capabilities?: readonly string[];
  }): void {
    const existing = this.clients.get(clientId);
    if (!existing || !this.runtimeBus) return;
    const updated: ControlPlaneClientRecord = {
      ...existing,
      label: input.label ?? existing.label,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
      capabilities: input.capabilities ? [...input.capabilities] : existing.capabilities,
      metadata: {
        ...existing.metadata,
        userId: input.principalId,
      },
    };
    this.clients.set(clientId, updated);
    this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.ws-auth');
    emitControlPlaneAuthGranted(this.runtimeBus, {
      sessionId: updated.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId: `control-plane:${clientId}:auth`,
    }, {
      clientId,
      principalId: input.principalId,
      principalKind: input.principalKind ?? 'token',
      scopes: [...(input.scopes ?? ['read:events'])],
    });
  }

  subscribeWebSocketClient(clientId: string, domains: readonly RuntimeEventDomain[]): void {
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient || !this.runtimeBus) return;
    const liveClient = this.liveClients.get(clientId);
    if (!liveClient) return;
    const nextDomains = [...new Set(domains)];
    for (const domain of nextDomains) {
      if (wsClient.unsubscribers.has(domain)) continue;
      const unsubscribe = this.runtimeBus.onDomain(domain, (envelope) => {
        this.touchWebSocketClient(clientId, { lastEventType: envelope.type });
        const serialized = serializeEnvelope(envelope);
        this.rememberEvent(domain, serialized);
        liveClient.send(domain, serialized);
      });
      wsClient.unsubscribers.set(domain, unsubscribe);
      wsClient.domains.add(domain);
    }
    this.touchWebSocketClient(clientId, { domains: [...wsClient.domains] });
  }

  unsubscribeWebSocketClient(clientId: string, domains?: readonly RuntimeEventDomain[]): void {
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    const targetDomains = domains?.length ? [...new Set(domains)] : [...wsClient.domains];
    for (const domain of targetDomains) {
      const unsubscribe = wsClient.unsubscribers.get(domain);
      unsubscribe?.();
      wsClient.unsubscribers.delete(domain);
      wsClient.domains.delete(domain);
    }
    this.touchWebSocketClient(clientId, { domains: [...wsClient.domains] });
  }

  closeWebSocketClient(clientId: string, reason = 'socket-closed'): void {
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    if (this.runtimeBus) {
      emitControlPlaneSubscriptionDropped(this.runtimeBus, {
        sessionId: this.clients.get(clientId)?.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId: wsClient.traceId,
      }, {
        clientId,
        subscriptionId: clientId,
        reason,
      });
      emitControlPlaneClientDisconnected(this.runtimeBus, {
        sessionId: this.clients.get(clientId)?.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId: wsClient.traceId,
      }, {
        clientId,
        reason,
      });
    }
    this.unsubscribeWebSocketClient(clientId);
    this.websocketClients.delete(clientId);
    this.liveClients.delete(clientId);
    const previous = this.clients.get(clientId);
    if (!previous) return;
    const disconnected: ControlPlaneClientRecord = {
      ...previous,
      connected: false,
      lastSeenAt: Date.now(),
    };
    this.clients.set(clientId, disconnected);
    this.dispatch?.syncControlPlaneClient(disconnected, 'control-plane.gateway.ws-disconnect');
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: [...this.clients.values()].some((client) => client.connected) ? 'connected' : 'disconnected',
    }, 'control-plane.gateway.ws-disconnect');
  }

  private replayRecentTraffic(send: (event: string, payload: unknown) => void): void {
    for (const recentEvent of this.listRecentEvents(20).reverse()) {
      send(recentEvent.event, recentEvent.payload);
    }
    for (const message of this.listSurfaceMessages(20).reverse()) {
      send('surface-message', message);
    }
  }

  createEventStream(request: Request, options: ControlPlaneEventStreamOptions = {}): Response {
    if (!this.runtimeBus) {
      return Response.json({ error: 'Runtime event bus unavailable' }, { status: 503 });
    }

    const encoder = new TextEncoder();
    const selectedDomains = options.domains?.length ? [...options.domains] : [...DEFAULT_DOMAINS];
    const clientId = options.clientId ?? `cp-${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.clientKind ?? 'web'}:${clientId}`;
    const now = Date.now();
    const transport = options.transport ?? 'sse';
    const surfaceKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    const clientRecord: ControlPlaneClientRecord = {
      id: clientId,
      kind: surfaceKind,
      label,
      transport: transport === 'ws' ? 'websocket' : transport === 'local' ? 'local' : 'sse',
      connected: true,
      sessionId: options.sessionId,
      routeId: options.routeId,
      surfaceId: options.surfaceId,
      authenticatedAt: now,
      lastSeenAt: now,
      remoteAddress: options.remoteAddress,
      capabilities: [...(options.capabilities ?? [])],
      metadata: {
        domains: selectedDomains,
        ...(options.principalId ? { userId: options.principalId } : {}),
      },
    };
    this.clients.set(clientId, clientRecord);
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: 'connected',
    }, 'control-plane.gateway.connect');
    this.dispatch?.syncControlPlaneClient(clientRecord, 'control-plane.gateway.connect');

    const traceId = `control-plane:${clientId}`;
    const eventClientKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    emitControlPlaneClientConnected(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      clientKind: eventClientKind,
      transport,
    });
    emitControlPlaneSubscriptionCreated(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      subscriptionId: clientId,
      topics: selectedDomains,
    });
    if (options.principalId) {
      emitControlPlaneAuthGranted(this.runtimeBus, {
        sessionId: options.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId,
      }, {
        clientId,
        principalId: options.principalId,
        principalKind: options.principalKind ?? 'token',
        scopes: [...(options.scopes ?? ['read:events'])],
      });
    }

    let teardown = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: string, payload: unknown): void => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        };
        const unsubs = selectedDomains.map((domain) => this.runtimeBus!.onDomain(domain, (envelope) => {
          const updated: ControlPlaneClientRecord = {
            ...clientRecord,
            lastSeenAt: Date.now(),
            metadata: {
              ...clientRecord.metadata,
              lastEventType: envelope.type,
            },
          };
          this.clients.set(clientId, updated);
          this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.heartbeat');
          const serialized = serializeEnvelope(envelope);
          this.rememberEvent(domain, serialized);
          send(domain, serialized);
        }));
        this.liveClients.set(clientId, {
          clientId,
          kind: options.clientKind ?? 'web',
          surfaceId: options.surfaceId,
          routeId: options.routeId,
          send,
        });
        const heartbeat = setInterval(() => {
          send('heartbeat', { clientId, ts: Date.now() });
        }, 15_000);
        teardown = () => {
          clearInterval(heartbeat);
          for (const unsub of unsubs) unsub();
          this.liveClients.delete(clientId);
          const previous = this.clients.get(clientId);
          if (previous) {
            const disconnected: ControlPlaneClientRecord = {
              ...previous,
              connected: false,
              lastSeenAt: Date.now(),
            };
            this.clients.set(clientId, disconnected);
            this.dispatch?.syncControlPlaneClient(disconnected, 'control-plane.gateway.disconnect');
            this.dispatch?.syncControlPlaneState({
              enabled: true,
              isRunning: true,
              connectionState: [...this.clients.values()].some((client) => client.connected) ? 'connected' : 'disconnected',
            }, 'control-plane.gateway.disconnect');
            emitControlPlaneSubscriptionDropped(this.runtimeBus!, {
              sessionId: options.sessionId ?? 'control-plane',
              source: 'control-plane.gateway',
              traceId,
            }, {
              clientId,
              subscriptionId: clientId,
              reason: 'stream-closed',
            });
            emitControlPlaneClientDisconnected(this.runtimeBus!, {
              sessionId: options.sessionId ?? 'control-plane',
              source: 'control-plane.gateway',
              traceId,
            }, {
              clientId,
              reason: 'stream-closed',
            });
          }
        };
        request.signal.addEventListener('abort', () => {
          teardown();
          controller.close();
        }, { once: true });
        send('ready', { clientId, domains: selectedDomains });
        for (const recentEvent of this.listRecentEvents(20).reverse()) {
          send(recentEvent.event, recentEvent.payload);
        }
        for (const message of this.listSurfaceMessages(20).reverse()) {
          send('surface-message', message);
        }
      },
      cancel: () => {
        teardown();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  renderWebUi(authTokenHint = ''): Response {
    return renderControlPlaneGatewayWebUi(authTokenHint);
  }

  private rememberEvent(event: string, payload: unknown): void {
    const record: ControlPlaneRecentEvent = {
      id: `cpe-${randomUUID().slice(0, 8)}`,
      event,
      createdAt: Date.now(),
      payload,
    };
    this.recentEvents.unshift(record);
    if (this.recentEvents.length > 500) {
      this.recentEvents.length = 500;
    }
    this.dispatch?.syncControlPlaneState({
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
      lastEventAt: record.createdAt,
    }, 'control-plane.gateway.event');
  }
}
