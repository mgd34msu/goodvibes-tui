import { createHttpTransport } from './http.ts';
import { createClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/client-transport';
import type { HttpTransportOptions, HttpTransportPeerClient, HttpTransportOperatorClient, HttpTransportSnapshot } from './http-types.ts';
import { createWebSocketConnector } from './shared.ts';
import { createRemoteUiRuntimeEvents } from './ui-runtime-events.ts';

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
  const transport = createClientTransport('realtime', operator, baseTransport.peer);

  return Object.freeze({
    ...transport,
    async snapshot(): Promise<RealtimeTransportSnapshot> {
      const snapshot = await baseTransport.snapshot();
      return {
        ...snapshot,
        kind: 'realtime',
      };
    },
  });
}
