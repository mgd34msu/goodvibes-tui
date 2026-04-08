import type { AcpConnection } from '../store/domains/acp.ts';
import type { RemoteRunnerContract } from './types.ts';

export interface RemoteHeartbeatSnapshot {
  readonly status: 'fresh' | 'stale' | 'offline';
  readonly lastSeenAt?: number;
  readonly ageMs?: number;
  readonly detail: string;
}

export function deriveRemoteHeartbeat(
  connection?: AcpConnection | null,
  contract?: RemoteRunnerContract | null,
): RemoteHeartbeatSnapshot {
  const lastSeenAt = connection?.connectedAt ?? contract?.transport.connectedAt;
  if (!lastSeenAt) {
    return {
      status: 'offline',
      detail: 'No heartbeat has been observed yet.',
    };
  }
  const ageMs = Math.max(0, Date.now() - lastSeenAt);
  if (connection?.transportState === 'terminal_failure' || connection?.transportState === 'disconnected') {
    return {
      status: 'offline',
      lastSeenAt,
      ageMs,
      detail: 'Transport is offline and requires reattach or redispatch.',
    };
  }
  if (ageMs > 5 * 60_000) {
    return {
      status: 'stale',
      lastSeenAt,
      ageMs,
      detail: 'Heartbeat is stale; remote recovery should be reviewed.',
    };
  }
  return {
    status: 'fresh',
    lastSeenAt,
    ageMs,
    detail: 'Heartbeat is within the healthy freshness window.',
  };
}
