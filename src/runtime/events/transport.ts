/**
 * TransportEvent — discriminated union covering ACP/daemon transport lifecycle events.
 *
 * Covers transport lifecycle events for the runtime event bus.
 */

export type TransportEvent =
  /** Transport layer is being initialised. */
  | { type: 'TRANSPORT_INITIALIZING'; transportId: string; protocol: string }
  /** Transport is authenticating with the remote endpoint. */
  | { type: 'TRANSPORT_AUTHENTICATING'; transportId: string }
  /** Transport connection is established and ready. */
  | { type: 'TRANSPORT_CONNECTED'; transportId: string; endpoint: string }
  /** Transport is synchronising state with the remote. */
  | { type: 'TRANSPORT_SYNCING'; transportId: string }
  /** Transport is operating with reduced reliability or throughput. */
  | { type: 'TRANSPORT_DEGRADED'; transportId: string; reason: string }
  /** Transport is attempting to reconnect after a failure. */
  | { type: 'TRANSPORT_RECONNECTING'; transportId: string; attempt: number; maxAttempts: number }
  /** Transport connection has been closed. */
  | { type: 'TRANSPORT_DISCONNECTED'; transportId: string; reason?: string; willRetry: boolean }
  /** Transport has failed unrecoverably and will not retry. */
  | { type: 'TRANSPORT_TERMINAL_FAILURE'; transportId: string; error: string };

/** All transport event type literals as a union. */
export type TransportEventType = TransportEvent['type'];
