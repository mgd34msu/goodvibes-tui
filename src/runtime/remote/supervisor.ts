import type { RuntimeStore } from '../store/index.ts';
import type { AcpConnection } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import { RemoteRunnerRegistry } from './runner-registry.ts';
import type { RemoteRunnerContract, RemoteRunnerPool } from '@pellux/goodvibes-sdk/platform/runtime/remote/types';
import { deriveRemoteCapabilities, type RemoteCapabilitySnapshot } from '@pellux/goodvibes-sdk/platform/runtime/remote/capabilities';
import { deriveRemoteHeartbeat, type RemoteHeartbeatSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/remote/heartbeat';
import { deriveRemoteNegotiation, type RemoteNegotiationSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/remote/negotiation';
import { deriveRemoteRecoveryActions, type RemoteRecoveryAction } from '@pellux/goodvibes-sdk/platform/runtime/remote/recovery';
import { buildRemoteSessionStateSnapshot, type RemoteSessionStateSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/remote/session-state';

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
  constructor(private readonly remoteRegistry: RemoteRunnerRegistry) {}

  public getSnapshot(store: RuntimeStore): RemoteSupervisorSnapshot {
    this.remoteRegistry.ensureContractsFromStore(store);
    const state = store.getState();
    const pools = this.remoteRegistry.listPools();
    const contracts = this.remoteRegistry.listContracts();
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
