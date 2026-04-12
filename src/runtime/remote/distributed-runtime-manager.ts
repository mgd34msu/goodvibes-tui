import { PersistentStore } from '../../state/persistent-store.ts';
import type {
  DistributedApprovalBridge,
  DistributedAutomationBridge,
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  DistributedRuntimeSnapshotStore,
  DistributedSessionBridge,
  DistributedWorkPriority,
  DistributedWorkType,
  StoredPairRequest,
  StoredPeerRecord,
  DistributedRuntimeWaiter,
} from './distributed-runtime-types.ts';
import { getDistributedNodeHostContract } from './distributed-runtime-contract.ts';
import {
  attachDistributedRuntime,
  getDistributedRuntimeSnapshot,
  listDistributedRuntimeAudit,
  listDistributedRuntimePairRequests,
  listDistributedRuntimePeers,
  listDistributedRuntimeWork,
  startDistributedRuntime,
} from './distributed-runtime-store.ts';
import {
  approveDistributedPairRequest,
  authenticateDistributedPeerToken,
  disconnectDistributedPeer,
  rejectDistributedPairRequest,
  requestDistributedPairing,
  revokeDistributedPeerToken,
  rotateDistributedPeerToken,
  verifyDistributedPairRequest,
  heartbeatDistributedPeer,
} from './distributed-runtime-pairing.ts';
import {
  cancelDistributedWork,
  claimDistributedWork,
  completeDistributedWork,
  enqueueDistributedWork,
  invokeDistributedPeer,
} from './distributed-runtime-work.ts';

const STORE_PATH = '.goodvibes/tui/remote/distributed-runtime.json';

export class DistributedRuntimeManager implements DistributedRuntimeManagerState {
  readonly store: PersistentStore<DistributedRuntimeSnapshotStore>;
  readonly pairRequests = new Map<string, StoredPairRequest>();
  readonly peers = new Map<string, StoredPeerRecord>();
  readonly work = new Map<string, DistributedPendingWork>();
  readonly audit: DistributedRuntimeAuditRecord[] = [];
  readonly waiters = new Map<string, DistributedRuntimeWaiter[]>();
  sessionBridge: DistributedSessionBridge | null = null;
  approvalBridge: DistributedApprovalBridge | null = null;
  automationBridge: DistributedAutomationBridge | null = null;
  eventPublisher: ((event: string, payload: unknown) => void) | null = null;
  loaded = false;

  constructor(store?: PersistentStore<DistributedRuntimeSnapshotStore>) {
    this.store = store ?? new PersistentStore<DistributedRuntimeSnapshotStore>(STORE_PATH);
  }

  attachRuntime(input: {
    readonly sessionBridge?: DistributedSessionBridge | null;
    readonly approvalBridge?: DistributedApprovalBridge | null;
    readonly automationBridge?: DistributedAutomationBridge | null;
    readonly eventPublisher?: ((event: string, payload: unknown) => void) | null;
  }): void {
    attachDistributedRuntime(this, input);
  }

  async start(): Promise<void> {
    await startDistributedRuntime(this);
  }

  listPairRequests(limit = 100): DistributedRuntimePairRequest[] {
    return listDistributedRuntimePairRequests(this, limit);
  }

  listPeers(kind?: DistributedPeerKind, limit = 200): DistributedPeerRecord[] {
    return listDistributedRuntimePeers(this, kind, limit);
  }

  listWork(limit = 200, peerId?: string): DistributedPendingWork[] {
    return listDistributedRuntimeWork(this, limit, peerId);
  }

  listAudit(limit = 100): DistributedRuntimeAuditRecord[] {
    return listDistributedRuntimeAudit(this, limit);
  }

  getSnapshot(): Record<string, unknown> {
    return getDistributedRuntimeSnapshot(this);
  }

  getNodeHostContract(): DistributedNodeHostContract {
    return getDistributedNodeHostContract();
  }

  async requestPairing(input: {
    readonly peerKind: DistributedPeerKind;
    readonly requestedId?: string;
    readonly label: string;
    readonly platform?: string;
    readonly deviceFamily?: string;
    readonly version?: string;
    readonly clientMode?: string;
    readonly capabilities?: readonly string[];
    readonly commands?: readonly string[];
    readonly metadata?: Record<string, unknown>;
    readonly requestedBy?: 'remote' | 'operator';
    readonly remoteAddress?: string;
    readonly ttlMs?: number;
  }): Promise<{ request: DistributedRuntimePairRequest; challenge: string }> {
    return requestDistributedPairing(this, input);
  }

  async approvePairRequest(
    requestId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
      readonly label?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<{ request: DistributedRuntimePairRequest; peer: DistributedPeerRecord } | null> {
    return approveDistributedPairRequest(this, requestId, input);
  }

  async rejectPairRequest(
    requestId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
    } = {},
  ): Promise<DistributedRuntimePairRequest | null> {
    return rejectDistributedPairRequest(this, requestId, input);
  }

  async verifyPairRequest(
    requestId: string,
    challenge: string,
    input: {
      readonly remoteAddress?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    return verifyDistributedPairRequest(this, requestId, challenge, input);
  }

  async rotatePeerToken(
    peerId: string,
    input: {
      readonly actor?: string;
      readonly label?: string;
      readonly scopes?: readonly string[];
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    return rotateDistributedPeerToken(this, peerId, input);
  }

  async revokePeerToken(
    peerId: string,
    input: {
      readonly actor?: string;
      readonly tokenId?: string;
      readonly note?: string;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    return revokeDistributedPeerToken(this, peerId, input);
  }

  async disconnectPeer(
    peerId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
      readonly requeueClaimedWork?: boolean;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    return disconnectDistributedPeer(this, peerId, input);
  }

  async enqueueWork(input: {
    readonly peerId: string;
    readonly type?: DistributedWorkType;
    readonly command: string;
    readonly payload?: unknown;
    readonly priority?: DistributedWorkPriority;
    readonly actor?: string;
    readonly timeoutMs?: number;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly automationRunId?: string;
    readonly automationJobId?: string;
    readonly approvalId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<DistributedPendingWork> {
    return enqueueDistributedWork(this, input);
  }

  async invokePeer(input: {
    readonly peerId: string;
    readonly command: string;
    readonly payload?: unknown;
    readonly priority?: DistributedWorkPriority;
    readonly actor?: string;
    readonly waitMs?: number;
    readonly timeoutMs?: number;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly automationRunId?: string;
    readonly automationJobId?: string;
    readonly approvalId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ work: DistributedPendingWork; completed: boolean }> {
    return invokeDistributedPeer(this, input);
  }

  async authenticatePeerToken(tokenValue: string, remoteAddress?: string): Promise<DistributedPeerAuth | null> {
    return authenticateDistributedPeerToken(this, tokenValue, remoteAddress);
  }

  async heartbeatPeer(
    auth: DistributedPeerAuth,
    input: {
      readonly remoteAddress?: string;
      readonly capabilities?: readonly string[];
      readonly commands?: readonly string[];
      readonly version?: string;
      readonly clientMode?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<DistributedPeerRecord> {
    return heartbeatDistributedPeer(this, auth, input);
  }

  async claimWork(
    auth: DistributedPeerAuth,
    input: {
      readonly maxItems?: number;
      readonly leaseMs?: number;
    } = {},
  ): Promise<DistributedPendingWork[]> {
    return claimDistributedWork(this, auth, input);
  }

  async completeWork(
    auth: DistributedPeerAuth,
    workId: string,
    input: {
      readonly status?: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown;
      readonly error?: string;
      readonly telemetry?: DistributedPendingWork['telemetry'];
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    return completeDistributedWork(this, auth, workId, input);
  }

  async cancelWork(
    workId: string,
    input: {
      readonly actor?: string;
      readonly reason?: string;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    return cancelDistributedWork(this, workId, input);
  }
}
