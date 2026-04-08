import type { AcpConnection } from '../store/domains/acp.ts';
import type { RemoteRunnerContract } from './types.ts';

export type RemoteCapabilityId =
  | 'files'
  | 'commands'
  | 'approvals'
  | 'artifacts'
  | 'resume'
  | 'shared-sandbox'
  | 'dedicated-sandbox';

export interface RemoteCapabilitySnapshot {
  readonly id: RemoteCapabilityId;
  readonly supported: boolean;
  readonly source: 'contract' | 'connection';
  readonly detail: string;
}

export function deriveRemoteCapabilities(
  contract?: RemoteRunnerContract | null,
  connection?: AcpConnection | null,
): RemoteCapabilitySnapshot[] {
  const tools = new Set(contract?.capabilityCeiling.allowedTools ?? []);
  const writeScope = contract?.capabilityCeiling.writeScope ?? [];
  const transportState = connection?.transportState ?? contract?.transport.state ?? 'disconnected';

  return [
    {
      id: 'files',
      supported: tools.has('read') || tools.has('write') || tools.has('edit') || writeScope.length > 0,
      source: contract ? 'contract' : 'connection',
      detail: writeScope.length > 0 ? `${writeScope.length} scoped path(s)` : 'tool-backed file access',
    },
    {
      id: 'commands',
      supported: tools.has('exec'),
      source: contract ? 'contract' : 'connection',
      detail: tools.has('exec') ? 'remote command execution allowed' : 'no command execution declared',
    },
    {
      id: 'approvals',
      supported: contract?.capabilityCeiling.reviewMode === 'wrfc' || transportState !== 'disconnected',
      source: contract ? 'contract' : 'connection',
      detail: contract?.capabilityCeiling.reviewMode === 'wrfc'
        ? 'review-backed remote flow'
        : 'approval continuity available through transport',
    },
    {
      id: 'artifacts',
      supported: Boolean(contract),
      source: contract ? 'contract' : 'connection',
      detail: contract ? 'runner contract can export evidence artifacts' : 'connection only',
    },
    {
      id: 'resume',
      supported: Boolean(connection?.taskId ?? contract?.taskId),
      source: connection?.taskId ? 'connection' : 'contract',
      detail: connection?.taskId ?? contract?.taskId ?? 'no resumable task bound',
    },
    {
      id: 'shared-sandbox',
      supported: writeScope.some((scope) => scope.includes('.goodvibes') || scope.includes('/workspace')),
      source: 'contract',
      detail: 'workspace-projected sandbox attachment',
    },
    {
      id: 'dedicated-sandbox',
      supported: contract?.trustClass === 'self-hosted-acp' && contract?.capabilityCeiling.communicationLane !== 'cohort',
      source: 'contract',
      detail: contract?.trustClass === 'self-hosted-acp'
        ? 'runner may be isolated into a dedicated remote lane'
        : 'shared daemon lane only',
    },
  ];
}
