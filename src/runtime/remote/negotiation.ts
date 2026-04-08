import type { AcpConnection } from '../store/domains/acp.ts';
import type { RemoteRunnerContract } from './types.ts';

export interface RemoteNegotiationSnapshot {
  readonly transport: 'acp' | 'daemon';
  readonly executionProtocol: 'direct' | 'gather-plan-apply';
  readonly reviewMode: 'none' | 'wrfc';
  readonly communicationLane: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
  readonly trustClass: string;
  readonly detail: string;
}

export function deriveRemoteNegotiation(
  contract?: RemoteRunnerContract | null,
  connection?: AcpConnection | null,
): RemoteNegotiationSnapshot {
  if (!contract) {
    return {
      transport: 'acp',
      executionProtocol: 'direct',
      reviewMode: 'none',
      communicationLane: 'direct',
      trustClass: connection ? 'connection-only' : 'unknown',
      detail: connection
        ? 'Transport is active but no runner contract has been registered yet.'
        : 'No remote contract or connection is available.',
    };
  }
  return {
    transport: contract.sourceTransport,
    executionProtocol: contract.capabilityCeiling.executionProtocol,
    reviewMode: contract.capabilityCeiling.reviewMode,
    communicationLane: contract.capabilityCeiling.communicationLane,
    trustClass: contract.trustClass,
    detail: `${contract.template} runner negotiated ${contract.capabilityCeiling.executionProtocol}/${contract.capabilityCeiling.reviewMode} on ${contract.sourceTransport}.`,
  };
}
