import type { AcpConnection } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import type { RuntimeStore } from './store/index.ts';
import type { DistributedRuntimeManager } from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime-manager';
import type {
  DistributedNodeHostContract,
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPendingWork,
  DistributedRuntimePairRequest,
  DistributedWorkPriority,
  DistributedWorkType,
} from './remote/index.ts';
import type {
  RemoteExecutionArtifact,
  RemoteRunnerContract,
  RemoteRunnerPool,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/types';
import type { RemoteRunnerRegistry } from './remote/runner-registry.ts';
import type { RemoteSupervisor, RemoteSupervisorSnapshot } from './remote/supervisor.ts';
import type { RemoteSessionStateSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/remote/session-state';

export interface PeerClientDependencies {
  readonly runtimeStore: RuntimeStore;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
}

export interface PeerClientPairingSnapshot {
  readonly requests: readonly DistributedRuntimePairRequest[];
  readonly total: number;
  readonly pending: number;
  readonly approved: number;
  readonly verified: number;
  readonly rejected: number;
  readonly expired: number;
}

export interface PeerClientPeerSnapshot {
  readonly peerId: string;
  readonly peer: DistributedPeerRecord | null;
  readonly session: RemoteSessionStateSnapshot | null;
  readonly runnerContract: RemoteRunnerContract | null;
  readonly pairRequests: readonly DistributedRuntimePairRequest[];
  readonly pendingWork: readonly DistributedPendingWork[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
}

export interface PeerClientRunnersSnapshot {
  readonly pools: readonly RemoteRunnerPool[];
  readonly contracts: readonly RemoteRunnerContract[];
  readonly artifacts: readonly RemoteExecutionArtifact[];
}

export interface PeerClientAcpSnapshot {
  readonly transportState: string;
  readonly totalMessages: number;
  readonly activeConnections: readonly AcpConnection[];
}

export interface PeerClientSnapshot {
  readonly capturedAt: number;
  readonly nodeHostContract: DistributedNodeHostContract;
  readonly acp: PeerClientAcpSnapshot;
  readonly pairing: PeerClientPairingSnapshot;
  readonly peers: readonly DistributedPeerRecord[];
  readonly peerSnapshots: readonly PeerClientPeerSnapshot[];
  readonly work: readonly DistributedPendingWork[];
  readonly runners: PeerClientRunnersSnapshot;
  readonly supervisor: RemoteSupervisorSnapshot;
}

export interface PeerClientPairingDomain {
  listRequests(limit?: number): DistributedRuntimePairRequest[];
  request(input: Parameters<DistributedRuntimeManager['requestPairing']>[0]): ReturnType<DistributedRuntimeManager['requestPairing']>;
  approve(
    requestId: string,
    input?: Parameters<DistributedRuntimeManager['approvePairRequest']>[1],
  ): ReturnType<DistributedRuntimeManager['approvePairRequest']>;
  reject(
    requestId: string,
    input?: Parameters<DistributedRuntimeManager['rejectPairRequest']>[1],
  ): ReturnType<DistributedRuntimeManager['rejectPairRequest']>;
  verify(
    requestId: string,
    challenge: string,
    input?: Parameters<DistributedRuntimeManager['verifyPairRequest']>[2],
  ): ReturnType<DistributedRuntimeManager['verifyPairRequest']>;
}

export interface PeerClientPeersDomain {
  list(kind?: DistributedPeerKind, limit?: number): DistributedPeerRecord[];
  get(peerId: string): DistributedPeerRecord | null;
  getSnapshot(peerId: string): PeerClientPeerSnapshot | null;
  authenticateToken(tokenValue: string, remoteAddress?: string): ReturnType<DistributedRuntimeManager['authenticatePeerToken']>;
  heartbeat(
    auth: DistributedPeerAuth,
    input?: Parameters<DistributedRuntimeManager['heartbeatPeer']>[1],
  ): ReturnType<DistributedRuntimeManager['heartbeatPeer']>;
  rotateToken(
    peerId: string,
    input?: Parameters<DistributedRuntimeManager['rotatePeerToken']>[1],
  ): ReturnType<DistributedRuntimeManager['rotatePeerToken']>;
  revokeToken(
    peerId: string,
    input?: Parameters<DistributedRuntimeManager['revokePeerToken']>[1],
  ): ReturnType<DistributedRuntimeManager['revokePeerToken']>;
  disconnect(
    peerId: string,
    input?: Parameters<DistributedRuntimeManager['disconnectPeer']>[1],
  ): ReturnType<DistributedRuntimeManager['disconnectPeer']>;
}

export interface PeerClientWorkDomain {
  list(limit?: number, peerId?: string): DistributedPendingWork[];
  enqueue(input: Parameters<DistributedRuntimeManager['enqueueWork']>[0]): ReturnType<DistributedRuntimeManager['enqueueWork']>;
  invoke(input: Parameters<DistributedRuntimeManager['invokePeer']>[0]): ReturnType<DistributedRuntimeManager['invokePeer']>;
  claim(
    auth: DistributedPeerAuth,
    input?: Parameters<DistributedRuntimeManager['claimWork']>[1],
  ): ReturnType<DistributedRuntimeManager['claimWork']>;
  complete(
    auth: DistributedPeerAuth,
    workId: string,
    input?: Parameters<DistributedRuntimeManager['completeWork']>[2],
  ): ReturnType<DistributedRuntimeManager['completeWork']>;
  cancel(
    workId: string,
    input?: Parameters<DistributedRuntimeManager['cancelWork']>[1],
  ): ReturnType<DistributedRuntimeManager['cancelWork']>;
}

export interface PeerClientRunnersDomain {
  listPools(): RemoteRunnerPool[];
  getPool(poolId: string): RemoteRunnerPool | null;
  createPool(input: Parameters<RemoteRunnerRegistry['createPool']>[0]): RemoteRunnerPool;
  assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null;
  removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null;
  listContracts(): RemoteRunnerContract[];
  getContract(runnerId: string): RemoteRunnerContract | null;
  registerContract(contract: RemoteRunnerContract): RemoteRunnerContract;
  upsertContractForAgent(agentId: string): RemoteRunnerContract | null;
  listArtifacts(): RemoteExecutionArtifact[];
  getArtifact(artifactId: string): RemoteExecutionArtifact | null;
  captureArtifactForAgent(agentId: string): RemoteExecutionArtifact | null;
  captureArtifactForRunner(runnerId: string): RemoteExecutionArtifact | null;
  exportArtifact(
    artifactId: string,
    path?: string,
  ): ReturnType<RemoteRunnerRegistry['exportArtifact']>;
  importArtifact(path: string): ReturnType<RemoteRunnerRegistry['importArtifact']>;
  buildReviewSummary(artifactId: string): string | null;
  exportSessionBundle(path?: string): ReturnType<RemoteRunnerRegistry['exportSessionBundle']>;
  importSessionBundle(path: string): ReturnType<RemoteRunnerRegistry['importSessionBundle']>;
}

export interface PeerClient {
  readonly pairing: PeerClientPairingDomain;
  readonly peers: PeerClientPeersDomain;
  readonly work: PeerClientWorkDomain;
  readonly runners: PeerClientRunnersDomain;
  getSnapshot(): PeerClientSnapshot;
  getNodeHostContract(): DistributedNodeHostContract;
}

function countRequests(requests: readonly DistributedRuntimePairRequest[]): PeerClientPairingSnapshot {
  return {
    requests,
    total: requests.length,
    pending: requests.filter((request) => request.status === 'pending').length,
    approved: requests.filter((request) => request.status === 'approved').length,
    verified: requests.filter((request) => request.status === 'verified').length,
    rejected: requests.filter((request) => request.status === 'rejected').length,
    expired: requests.filter((request) => request.status === 'expired').length,
  };
}

function collectPeerIds(
  peers: readonly DistributedPeerRecord[],
  contracts: readonly RemoteRunnerContract[],
  sessions: readonly RemoteSessionStateSnapshot[],
  requests: readonly DistributedRuntimePairRequest[],
  work: readonly DistributedPendingWork[],
): readonly string[] {
  const ids = new Set<string>();
  for (const peer of peers) ids.add(peer.id);
  for (const contract of contracts) ids.add(contract.runnerId);
  for (const session of sessions) ids.add(session.runnerId);
  for (const request of requests) {
    if (request.peerId) ids.add(request.peerId);
    if (request.requestedId) ids.add(request.requestedId);
  }
  for (const item of work) ids.add(item.peerId);
  return [...ids].sort();
}

function buildAcpSnapshot(store: RuntimeStore): PeerClientAcpSnapshot {
  const state = store.getState().acp;
  return {
    transportState: state.managerTransportState,
    totalMessages: state.totalMessages,
    activeConnections: state.activeConnectionIds
      .map((id) => state.connections.get(id))
      .filter((connection): connection is AcpConnection => connection !== undefined),
  };
}

function buildPeerSnapshot(deps: PeerClientDependencies, peerId: string): PeerClientPeerSnapshot | null {
  deps.remoteRunnerRegistry.ensureContractsFromStore(deps.runtimeStore);
  const peers = deps.distributedRuntime.listPeers(undefined, 500);
  const peer = peers.find((entry) => entry.id === peerId) ?? null;
  const runnerContract = deps.remoteRunnerRegistry.getContract(peerId);
  const pairRequests = deps.distributedRuntime
    .listPairRequests(250)
    .filter((request) => request.peerId === peerId || request.requestedId === peerId);
  const pendingWork = deps.distributedRuntime.listWork(250, peerId);
  const artifacts = deps.remoteRunnerRegistry.listArtifacts().filter((artifact) => artifact.runnerId === peerId);
  const sessions = deps.remoteSupervisor.getSnapshot(deps.runtimeStore).sessions;
  const session = sessions.find((entry) => entry.runnerId === peerId) ?? null;
  if (!peer && !runnerContract && !session && pairRequests.length === 0 && pendingWork.length === 0 && artifacts.length === 0) {
    return null;
  }
  return {
    peerId,
    peer,
    session,
    runnerContract: runnerContract ?? null,
    pairRequests,
    pendingWork,
    artifacts,
  };
}

function buildPeerSnapshots(deps: PeerClientDependencies): readonly PeerClientPeerSnapshot[] {
  deps.remoteRunnerRegistry.ensureContractsFromStore(deps.runtimeStore);
  const pairingRequests = deps.distributedRuntime.listPairRequests(250);
  const peers = deps.distributedRuntime.listPeers(undefined, 500);
  const work = deps.distributedRuntime.listWork(500);
  const contracts = deps.remoteRunnerRegistry.listContracts();
  const sessions = deps.remoteSupervisor.getSnapshot(deps.runtimeStore).sessions;
  const peerIds = collectPeerIds(peers, contracts, sessions, pairingRequests, work);
  const snapshots = peerIds
    .map((peerId) => buildPeerSnapshot(deps, peerId))
    .filter((snapshot): snapshot is PeerClientPeerSnapshot => snapshot !== null);
  return Object.freeze(snapshots);
}

function buildSnapshot(deps: PeerClientDependencies): PeerClientSnapshot {
  deps.remoteRunnerRegistry.ensureContractsFromStore(deps.runtimeStore);
  const pairingRequests = deps.distributedRuntime.listPairRequests(250);
  const peers = deps.distributedRuntime.listPeers(undefined, 500);
  const work = deps.distributedRuntime.listWork(500);
  const pools = deps.remoteRunnerRegistry.listPools();
  const contracts = deps.remoteRunnerRegistry.listContracts();
  const artifacts = deps.remoteRunnerRegistry.listArtifacts();
  const supervisor = deps.remoteSupervisor.getSnapshot(deps.runtimeStore);
  return Object.freeze({
    capturedAt: Date.now(),
    nodeHostContract: deps.distributedRuntime.getNodeHostContract(),
    acp: buildAcpSnapshot(deps.runtimeStore),
    pairing: countRequests(pairingRequests),
    peers,
    peerSnapshots: buildPeerSnapshots(deps),
    work,
    runners: {
      pools,
      contracts,
      artifacts,
    },
    supervisor,
  });
}

export function createPeerClient(deps: PeerClientDependencies): PeerClient {
  const resolved = Object.freeze({ ...deps });
  return {
    pairing: {
      listRequests(limit = 100): DistributedRuntimePairRequest[] {
        return resolved.distributedRuntime.listPairRequests(limit);
      },
      request(input) {
        return resolved.distributedRuntime.requestPairing(input);
      },
      approve(requestId, input) {
        return resolved.distributedRuntime.approvePairRequest(requestId, input ?? {});
      },
      reject(requestId, input) {
        return resolved.distributedRuntime.rejectPairRequest(requestId, input ?? {});
      },
      verify(requestId, challenge, input) {
        return resolved.distributedRuntime.verifyPairRequest(requestId, challenge, input ?? {});
      },
    },
    peers: {
      list(kind, limit = 200): DistributedPeerRecord[] {
        return resolved.distributedRuntime.listPeers(kind, limit);
      },
      get(peerId: string): DistributedPeerRecord | null {
        return resolved.distributedRuntime.listPeers(undefined, 500).find((peer) => peer.id === peerId) ?? null;
      },
      getSnapshot(peerId: string): PeerClientPeerSnapshot | null {
        return buildPeerSnapshot(resolved, peerId);
      },
      authenticateToken(tokenValue: string, remoteAddress?: string) {
        return resolved.distributedRuntime.authenticatePeerToken(tokenValue, remoteAddress);
      },
      heartbeat(auth: DistributedPeerAuth, input) {
        return resolved.distributedRuntime.heartbeatPeer(auth, input ?? {});
      },
      rotateToken(peerId: string, input) {
        return resolved.distributedRuntime.rotatePeerToken(peerId, input ?? {});
      },
      revokeToken(peerId: string, input) {
        return resolved.distributedRuntime.revokePeerToken(peerId, input ?? {});
      },
      disconnect(peerId: string, input) {
        return resolved.distributedRuntime.disconnectPeer(peerId, input ?? {});
      },
    },
    work: {
      list(limit = 200, peerId?: string): DistributedPendingWork[] {
        return resolved.distributedRuntime.listWork(limit, peerId);
      },
      enqueue(input) {
        return resolved.distributedRuntime.enqueueWork(input);
      },
      invoke(input) {
        return resolved.distributedRuntime.invokePeer(input);
      },
      claim(auth: DistributedPeerAuth, input) {
        return resolved.distributedRuntime.claimWork(auth, input ?? {});
      },
      complete(auth: DistributedPeerAuth, workId: string, input) {
        return resolved.distributedRuntime.completeWork(auth, workId, input ?? {});
      },
      cancel(workId: string, input) {
        return resolved.distributedRuntime.cancelWork(workId, input ?? {});
      },
    },
    runners: {
      listPools(): RemoteRunnerPool[] {
        return resolved.remoteRunnerRegistry.listPools();
      },
      getPool(poolId: string): RemoteRunnerPool | null {
        return resolved.remoteRunnerRegistry.getPool(poolId);
      },
      createPool(input: Parameters<RemoteRunnerRegistry['createPool']>[0]): RemoteRunnerPool {
        return resolved.remoteRunnerRegistry.createPool(input);
      },
      assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
        return resolved.remoteRunnerRegistry.assignRunnerToPool(poolId, runnerId);
      },
      removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
        return resolved.remoteRunnerRegistry.removeRunnerFromPool(poolId, runnerId);
      },
      listContracts(): RemoteRunnerContract[] {
        return resolved.remoteRunnerRegistry.listContracts();
      },
      getContract(runnerId: string): RemoteRunnerContract | null {
        return resolved.remoteRunnerRegistry.getContract(runnerId);
      },
      registerContract(contract: RemoteRunnerContract): RemoteRunnerContract {
        return resolved.remoteRunnerRegistry.registerContract(contract);
      },
      upsertContractForAgent(agentId: string): RemoteRunnerContract | null {
        return resolved.remoteRunnerRegistry.upsertContractForAgent(agentId, resolved.runtimeStore);
      },
      listArtifacts(): RemoteExecutionArtifact[] {
        return resolved.remoteRunnerRegistry.listArtifacts();
      },
      getArtifact(artifactId: string): RemoteExecutionArtifact | null {
        return resolved.remoteRunnerRegistry.getArtifact(artifactId);
      },
      captureArtifactForAgent(agentId: string): RemoteExecutionArtifact | null {
        return resolved.remoteRunnerRegistry.captureArtifactForAgent(agentId, resolved.runtimeStore);
      },
      captureArtifactForRunner(runnerId: string): RemoteExecutionArtifact | null {
        return resolved.remoteRunnerRegistry.captureArtifactForRunner(runnerId, resolved.runtimeStore);
      },
      exportArtifact(artifactId: string, path?: string) {
        return resolved.remoteRunnerRegistry.exportArtifact(artifactId, path);
      },
      importArtifact(path: string) {
        return resolved.remoteRunnerRegistry.importArtifact(path);
      },
      buildReviewSummary(artifactId: string): string | null {
        return resolved.remoteRunnerRegistry.buildReviewSummary(artifactId);
      },
      exportSessionBundle(path?: string) {
        return resolved.remoteRunnerRegistry.exportSessionBundle(resolved.runtimeStore, path);
      },
      importSessionBundle(path: string) {
        return resolved.remoteRunnerRegistry.importSessionBundle(path);
      },
    },
    getSnapshot(): PeerClientSnapshot {
      return buildSnapshot(resolved);
    },
    getNodeHostContract(): DistributedNodeHostContract {
      return resolved.distributedRuntime.getNodeHostContract();
    },
  };
}
