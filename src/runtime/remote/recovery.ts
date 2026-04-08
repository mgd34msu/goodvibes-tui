import type { AcpConnection } from '../store/domains/acp.ts';
import type { RemoteRunnerContract } from './types.ts';
import type { RemoteHeartbeatSnapshot } from './heartbeat.ts';

export interface RemoteRecoveryAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly reason: string;
}

export function deriveRemoteRecoveryActions(
  connection?: AcpConnection | null,
  contract?: RemoteRunnerContract | null,
  heartbeat?: RemoteHeartbeatSnapshot,
): RemoteRecoveryAction[] {
  const actions: RemoteRecoveryAction[] = [];
  const runnerId = contract?.runnerId ?? connection?.agentId ?? 'selected';
  const taskId = connection?.taskId ?? contract?.taskId;

  if (connection?.lastError || contract?.transport.lastError) {
    actions.push({
      id: 'review-health',
      label: 'Review remote health',
      command: '/health review',
      reason: connection?.lastError ?? contract?.transport.lastError ?? 'Remote transport reported an error.',
    });
  }
  if (heartbeat?.status === 'stale') {
    actions.push({
      id: 'reconnect',
      label: 'Reinspect remote runtime',
      command: `/remote show ${runnerId}`,
      reason: heartbeat.detail,
    });
  }
  if (taskId) {
    actions.push({
      id: 'resume',
      label: 'Resume bound remote task',
      command: `/task status ${taskId}`,
      reason: `Remote session is still bound to task ${taskId}.`,
    });
  }
  actions.push({
    id: 'remote-panel',
    label: 'Open remote workspace',
    command: '/remote',
    reason: 'Inspect transport, runner contracts, and artifacts together.',
  });

  return actions;
}
