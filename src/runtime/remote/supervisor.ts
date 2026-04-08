import type { RuntimeStore } from '../store/index.ts';
import type { AcpConnection } from '../store/domains/acp.ts';
import { getRemoteRunnerRegistry } from './runner-registry.ts';
import type { RemoteRunnerContract, RemoteRunnerPool } from './types.ts';
import { deriveRemoteCapabilities, type RemoteCapabilitySnapshot } from './capabilities.ts';
import { deriveRemoteHeartbeat, type RemoteHeartbeatSnapshot } from './heartbeat.ts';
import { deriveRemoteNegotiation, type RemoteNegotiationSnapshot } from './negotiation.ts';
import { deriveRemoteRecoveryActions, type RemoteRecoveryAction } from './recovery.ts';
import { buildRemoteSessionStateSnapshot, type RemoteSessionStateSnapshot } from './session-state.ts';

export interface RemoteSupervisorSnapshot {
  readonly capturedAt: number;
  readonly totalConnections: number;
  readonly activeConnections: number;
  readonly degradedConnections: number;
  readonly pools: readonly RemoteRunnerPool[];
  readonly sessions: readonly RemoteSessionStateSnapshot[];
}

function stateIsDegraded(state: string): boolean {
  return state === 'degraded' || state === 'reconnecting' || state === 'terminal_failure';
}

export class RemoteSupervisor {
  public getSnapshot(store: RuntimeStore): RemoteSupervisorSnapshot {
    const remoteRegistry = getRemoteRunnerRegistry();
    remoteRegistry.ensureContractsFromStore(store);
    const state = store.getState();
    const pools = remoteRegistry.listPools();
    const contracts = remoteRegistry.listContracts();
    const connections = [...state.acp.connections.values()];
    const runnerIds = new Set<string>([
      ...connections.map((connection) => connection.agentId),
      ...contracts.map((contract) => contract.runnerId),
    ]);
    const sessions = [...runnerIds].map((runnerId) => this.describeRunner(runnerId, connections, contracts));
    return Object.freeze({
      capturedAt: Date.now(),
      totalConnections: connections.length,
      activeConnections: state.acp.activeConnectionIds.length,
      degradedConnections: sessions.filter((session) => stateIsDegraded(session.transportState) || session.heartbeat.status !== 'fresh').length,
      pools,
      sessions,
    });
  }

  private describeRunner(
    runnerId: string,
    connections: readonly AcpConnection[],
    contracts: readonly RemoteRunnerContract[],
  ): RemoteSessionStateSnapshot {
    const connection = connections.find((entry) => entry.agentId === runnerId) ?? null;
    const contract = contracts.find((entry) => entry.runnerId === runnerId) ?? null;
    const capabilities: readonly RemoteCapabilitySnapshot[] = deriveRemoteCapabilities(contract, connection);
    const heartbeat: RemoteHeartbeatSnapshot = deriveRemoteHeartbeat(connection, contract);
    const negotiation: RemoteNegotiationSnapshot = deriveRemoteNegotiation(contract, connection);
    const recovery: readonly RemoteRecoveryAction[] = deriveRemoteRecoveryActions(connection, contract, heartbeat);
    return buildRemoteSessionStateSnapshot({
      runnerId,
      label: connection?.label ?? contract?.label ?? runnerId,
      connection,
      contract,
      heartbeat,
      negotiation,
      capabilities,
      recovery,
    });
  }
}

let _remoteSupervisor: RemoteSupervisor | null = null;

export function getRemoteSupervisor(): RemoteSupervisor {
  if (_remoteSupervisor === null) {
    _remoteSupervisor = new RemoteSupervisor();
  }
  return _remoteSupervisor;
}

export function resetRemoteSupervisorForTesting(): void {
  _remoteSupervisor = null;
}
