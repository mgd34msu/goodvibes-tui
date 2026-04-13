import { createHttpTransport } from './http.ts';
import type { HttpTransportOptions, HttpTransportPeerClient, HttpTransportOperatorClient, HttpTransportSnapshot } from './http-types.ts';
import { createRemoteUiRuntimeEvents, createWebSocketConnector } from './shared.ts';

export interface RealtimeTransportOptions extends HttpTransportOptions {
  readonly webSocketImpl?: typeof WebSocket;
}

export interface RealtimeTransportSnapshot extends Omit<HttpTransportSnapshot, 'kind'> {
  readonly kind: 'realtime';
}

export interface RealtimeTransport {
  readonly kind: 'realtime';
  readonly operator: HttpTransportOperatorClient;
  readonly peer: HttpTransportPeerClient;
  getOperatorClient(): HttpTransportOperatorClient;
  getPeerClient(): HttpTransportPeerClient;
  snapshot(): Promise<RealtimeTransportSnapshot>;
}

export function createRealtimeTransport(options: RealtimeTransportOptions): RealtimeTransport {
  const baseTransport = createHttpTransport({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    fetchImpl: options.fetchImpl,
  });
  const WebSocketImpl = options.webSocketImpl ?? WebSocket;
  const events = createRemoteUiRuntimeEvents(
    createWebSocketConnector(options.baseUrl, options.authToken, WebSocketImpl),
  );
  const operator = {
    ...baseTransport.operator,
    events,
  };

  return Object.freeze({
    kind: 'realtime' as const,
    operator,
    peer: baseTransport.peer,
    getOperatorClient(): HttpTransportOperatorClient {
      return operator;
    },
    getPeerClient(): HttpTransportPeerClient {
      return baseTransport.peer;
    },
    async snapshot(): Promise<RealtimeTransportSnapshot> {
      const snapshot = await baseTransport.snapshot();
      return {
        ...snapshot,
        kind: 'realtime',
      };
    },
  });
}
