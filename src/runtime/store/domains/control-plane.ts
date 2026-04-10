/**
 * Control-plane domain state — connected clients and live subscription posture.
 */

import type { AutomationSurfaceKind } from '../../../automation/types.ts';

export type ControlPlaneClientKind = AutomationSurfaceKind;
export type ControlPlaneTransportKind = 'sse' | 'websocket' | 'http' | 'local';
export type ControlPlaneConnectionState =
  | 'disabled'
  | 'initializing'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'terminal_failure';

export interface ControlPlaneClientRecord {
  readonly id: string;
  readonly kind: ControlPlaneClientKind;
  readonly label: string;
  readonly transport: ControlPlaneTransportKind;
  readonly connected: boolean;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceId?: string;
  readonly authenticatedAt?: number;
  readonly lastSeenAt?: number;
  readonly remoteAddress?: string;
  readonly capabilities: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface ControlPlaneDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly enabled: boolean;
  readonly connectionState: ControlPlaneConnectionState;
  readonly host: string;
  readonly port: number;
  readonly clients: Map<string, ControlPlaneClientRecord>;
  readonly activeClients: Map<string, ControlPlaneClientRecord>;
  readonly clientIds: string[];
  readonly activeClientIds: string[];
  readonly isRunning: boolean;
  readonly lastError?: string;
  readonly totalConnections: number;
  readonly totalDisconnects: number;
  readonly totalFailures: number;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly lastRequestAt?: number;
  readonly lastEventAt?: number;
}

export function createInitialControlPlaneState(): ControlPlaneDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    enabled: false,
    connectionState: 'disabled',
    host: '127.0.0.1',
    port: 3421,
    clients: new Map(),
    activeClients: new Map(),
    clientIds: [],
    activeClientIds: [],
    isRunning: false,
    lastError: undefined,
    totalConnections: 0,
    totalDisconnects: 0,
    totalFailures: 0,
    requestCount: 0,
    errorCount: 0,
    lastRequestAt: undefined,
    lastEventAt: undefined,
  };
}
