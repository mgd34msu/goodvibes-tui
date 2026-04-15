/**
 * Remote Substrate — Public API
 *
 * Barrel export and `createRemoteSubstrate()` factory.
 *
 * The remote substrate layer covers identity, handshake, sync, and transport:
 * - Durable identity stable across reconnects
 * - Handshake tokens with epoch tracking
 * - Typed transport messages (control / data / ack / failure)
 * - Reconnect engine with exponential backoff and replay
 * - State sync into runtime store domains
 * - Observability panel data provider
 */

import { randomUUID } from 'node:crypto';
import { DurableIdentityManager } from '@pellux/goodvibes-sdk/platform/runtime/remote/identity';
import { ReconnectEngine } from '@pellux/goodvibes-sdk/platform/runtime/remote/reconnect';
import { RemoteStateSyncer, createNoOpSyncCallbacks } from '@pellux/goodvibes-sdk/platform/runtime/remote/sync';
import { RemoteObservabilityProvider } from '@pellux/goodvibes-sdk/platform/runtime/remote/observability';
import type {
  RemoteSubstrateConfig,
  RemoteSession,
  RemoteTask,
  RemoteHealth,
  DurableIdentity,
  HandshakeToken,
  ReplayConfig,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/types';
import type { SyncStoreCallbacks } from '@pellux/goodvibes-sdk/platform/runtime/remote/sync';
import type { TransportAdapter, ReconnectEngineCallbacks } from '@pellux/goodvibes-sdk/platform/runtime/remote/reconnect';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';

// ── Re-exports ────────────────────────────────────────────────────────────────

export type {
  // Core types
  DurableIdentity,
  HandshakeToken,
  ReplayConfig,
  RemoteSession,
  RemoteTask,
  RemoteHealth,
  RemoteSubstrateConfig,
  RemoteConnectionHealth,
  RemoteRunnerContract,
  RemoteRunnerCapabilityCeiling,
  RemoteExecutionArtifact,
  RemoteRunnerEvidenceSummary,
  TransportMessage,
  ControlMessage,
  DataMessage,
  AckMessage,
  FailureMessage,
  TransportMessageBase,
  TransportMessageClass,
  TransportErrorCategory,
  RetryPolicy,
  AuthProvider,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/types';

export type {
  // Identity
  IdentitySnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/identity';

export type {
  // Reconnect
  ConnectOutcome,
  TransportAdapter,
  ReconnectEngineCallbacks,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/reconnect';

export type {
  // Sync
  SyncStoreCallbacks,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/sync';

export type {
  // Observability
  RemoteConnectionSnapshot,
  RemoteTaskSnapshot,
  RemoteObservabilitySnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/observability';

export {
  // Transport contract
  CONTROL_RETRY_POLICY,
  DATA_RETRY_POLICY,
  ACK_RETRY_POLICY,
  FAILURE_RETRY_POLICY,
  createControlMessage,
  createDataMessage,
  createAckMessage,
  createFailureMessage,
  computeRetryDelay,
  shouldRetry,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/transport-contract';

export type {
  ControlMessageType,
  DataMessageType,
  ControlPayloads,
  DataPayloads,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/transport-contract';

export {
  CURRENT_PROTOCOL_VERSION,
  TRANSPORT_COMPATIBILITY_MATRIX,
  VersionMismatchError,
  negotiateProtocolVersion,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/transport-contract';

export type {
  ProtocolVersion,
  CompatibilityMatrix,
  CompatibilityEntry,
  VersionNegotiationResult,
  NegotiatedProtocol,
  DowngradeReason,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/types';

export { DurableIdentityManager } from '@pellux/goodvibes-sdk/platform/runtime/remote/identity';
export { ReconnectEngine, generateIdempotencyKey } from '@pellux/goodvibes-sdk/platform/runtime/remote/reconnect';
export { RemoteStateSyncer, createNoOpSyncCallbacks, buildAcpConnectionEntry, countActiveRemoteConnections, extractRemoteTaskIds } from '@pellux/goodvibes-sdk/platform/runtime/remote/sync';
export { RemoteObservabilityProvider } from '@pellux/goodvibes-sdk/platform/runtime/remote/observability';
export {
  deriveRemoteCapabilities,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/capabilities';
export type {
  RemoteCapabilityId,
  RemoteCapabilitySnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/capabilities';
export {
  deriveRemoteHeartbeat,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/heartbeat';
export type {
  RemoteHeartbeatSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/heartbeat';
export {
  deriveRemoteNegotiation,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/negotiation';
export type {
  RemoteNegotiationSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/negotiation';
export {
  deriveRemoteRecoveryActions,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/recovery';
export type {
  RemoteRecoveryAction,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/recovery';
export {
  buildRemoteSessionStateSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/session-state';
export type {
  RemoteSessionStateSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/session-state';
export {
  RemoteSupervisor,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/supervisor';
export type {
  RemoteSupervisorSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/supervisor';
export {
  RemoteRunnerRegistry,
  exportRemoteArtifactForAgent,
  importRemoteArtifact,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/runner-registry';
export type {
  DistributedPeerKind,
  DistributedPairRequestStatus,
  DistributedPeerStatus,
  DistributedWorkPriority,
  DistributedWorkStatus,
  DistributedWorkType,
  DistributedSessionBridge,
  DistributedApprovalBridge,
  DistributedAutomationBridge,
  DistributedRuntimePairRequest,
  DistributedPeerTokenRecord,
  DistributedPeerRecord,
  DistributedPendingWork,
  DistributedRuntimeAuditRecord,
  DistributedPeerAuth,
  DistributedNodeHostContract,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime';
export {
  DistributedRuntimeManager,
  getDistributedNodeHostContract,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime';

// ── RemoteSubstrate facade ────────────────────────────────────────────────────

/**
 * RemoteSubstrate — high-level facade wiring together all remote substrate components.
 *
 * This class composes DurableIdentityManager, ReconnectEngine, RemoteStateSyncer,
 * and RemoteObservabilityProvider into a single, lifecycle-managed unit.
 *
 * Callers supply a TransportAdapter (the actual I/O layer) and optional
 * SyncStoreCallbacks (to apply state changes to local store domains).
 *
 * @example
 * ```ts
 * const substrate = createRemoteSubstrate({
 *   endpoint: 'wss://remote.example.com/agent',
 *   identity: identityManager.current,
 *   authProvider: { getToken: async () => 'bearer-token' },
 * });
 *
 * substrate.attach(wsAdapter, storeCallbacks);
 * await substrate.connect();
 *
 * // Panel rendering:
 * const obs = substrate.observability;
 * obs.subscribe(() => renderRemotePanel(obs.getSnapshot()));
 * ```
 */
export class RemoteSubstrate {
  private readonly _identity: DurableIdentityManager;
  private readonly _observability: RemoteObservabilityProvider;
  private _syncer: RemoteStateSyncer;
  private _engine: ReconnectEngine | null = null;
  private _session: RemoteSession;
  private _epoch = 0;
  private _disposed = false;

  constructor(
    private readonly config: RemoteSubstrateConfig,
    private adapter: TransportAdapter | null = null,
  ) {
    this._identity = new DurableIdentityManager(config.identity);
    this._observability = new RemoteObservabilityProvider();
    this._syncer = new RemoteStateSyncer(createNoOpSyncCallbacks());
    this._session = this._buildInitialSession();
  }

  /** The observability panel data provider for this substrate. */
  get observability(): RemoteObservabilityProvider {
    return this._observability;
  }

  /** Current remote session snapshot. */
  get session(): RemoteSession {
    return this._session;
  }

  /** Current durable identity. */
  get identity(): DurableIdentity {
    return this._identity.current;
  }

  /**
   * Attach a transport adapter and store callbacks.
   *
   * Must be called before `connect()`. Can be called again after reconnection
   * with a new adapter (e.g. replacing a failed WebSocket with a fresh one).
   *
   * @param adapter - The transport I/O adapter.
   * @param storeCallbacks - Optional store mutation callbacks for state sync.
   */
  attach(adapter: TransportAdapter, storeCallbacks?: SyncStoreCallbacks): void {
    this.adapter = adapter;
    this._syncer = new RemoteStateSyncer(storeCallbacks ?? createNoOpSyncCallbacks());
    this._rebuildEngine();
  }

  /**
   * Establish the initial connection to the remote substrate.
   *
   * @returns True if connected successfully, false on terminal failure.
   */
  async connect(): Promise<boolean> {
    if (this._disposed || !this._engine) {
      logger.error('RemoteSubstrate.connect: substrate disposed or no adapter attached');
      return false;
    }

    const authToken = await this._getAuthToken();
    return this._engine.connect(authToken);
  }

  /**
   * Drive the reconnect loop after a connection failure.
   *
   * @returns True if eventually reconnected, false on terminal failure.
   */
  async reconnect(): Promise<boolean> {
    if (this._disposed || !this._engine) return false;
    return this._engine.reconnect(() => this._getAuthToken());
  }

  /**
   * Acknowledge a received message offset.
   *
   * @param offset - The message offset to acknowledge.
   */
  ackOffset(offset: number): void {
    this._engine?.ackOffset(offset);
    this._session = {
      ...this._session,
      lastAckedOffset: Math.max(this._session.lastAckedOffset, offset),
    };
    this._observability.updateSession(this._session);
  }

  /**
   * Apply an incoming remote task update.
   *
   * @param task - Remote task snapshot from the transport.
   */
  receiveTaskUpdate(task: RemoteTask): void {
    const tasks = new Map(this._session.remoteTasks);
    tasks.set(task.taskId, task);
    this._session = { ...this._session, remoteTasks: tasks };
    this._syncer.syncTaskUpdate(this._session, task);
    this._observability.updateSession(this._session);
  }

  /**
   * Apply an incoming remote health update.
   *
   * @param health - Remote health snapshot from the transport.
   */
  receiveHealthUpdate(health: RemoteHealth): void {
    this._session = { ...this._session, health };
    this._syncer.syncHealthUpdate(this._session, health);
    this._observability.updateSession(this._session);
  }

  /** Dispose the substrate, cancelling any pending reconnects. */
  dispose(): void {
    this._disposed = true;
    this._engine?.dispose();
    this._engine = null;
    this._observability.untrackSession(this._session.connectionId);
    this._observability.dispose();
    logger.debug('RemoteSubstrate: disposed', { connectionId: this._session.connectionId });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _buildInitialSession(): RemoteSession {
    return {
      connectionId: randomUUID(),
      identity: this._identity.current,
      endpoint: this.config.endpoint,
      transportState: 'disconnected',
      handshakeToken: undefined,
      replayConfig: {
        lastAckedOffset: 0,
        maxReplayCount: 500,
        enabled: true,
        ...this.config.replayConfig,
      },
      reconnectAttempts: 0,
      lastConnectedAt: undefined,
      lastError: undefined,
      remoteTasks: new Map(),
      health: { status: 'unreachable', updatedAt: Date.now() },
      messagesSent: 0,
      messagesReceived: 0,
      lastAckedOffset: 0,
    };
  }

  private _rebuildEngine(): void {
    this._engine?.dispose();
    if (!this.adapter) return;

    const callbacks: ReconnectEngineCallbacks = {
      onInitializing: (attempt) => {
        this._session = { ...this._session, transportState: 'initializing', reconnectAttempts: attempt };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
      },
      onAuthenticating: () => {
        this._session = { ...this._session, transportState: 'authenticating' };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
      },
      onConnected: (token: HandshakeToken, epoch: number) => {
        this._epoch = epoch;
        this._session = {
          ...this._session,
          transportState: 'connected',
          handshakeToken: token,
          lastConnectedAt: Date.now(),
          lastError: undefined,
          reconnectAttempts: 0,
        };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
      },
      onSyncing: () => {
        this._session = { ...this._session, transportState: 'syncing' };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
      },
      onReconnecting: (attempt, maxAttempts, _delayMs) => {
        this._session = {
          ...this._session,
          transportState: 'reconnecting',
          reconnectAttempts: attempt,
        };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
        logger.warn('RemoteSubstrate: reconnecting', {
          attempt,
          maxAttempts,
          sessionId: this._session.identity.sessionId,
        });
      },
      onDisconnected: (reason, willRetry) => {
        this._session = {
          ...this._session,
          transportState: 'disconnected',
          lastError: reason,
        };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
        logger.warn('RemoteSubstrate: disconnected', { reason, willRetry });
      },
      onTerminalFailure: (error) => {
        this._session = {
          ...this._session,
          transportState: 'terminal_failure',
          lastError: error,
        };
        this._observability.updateSession(this._session);
        this._syncer.syncTransportState(this._session);
        logger.error('RemoteSubstrate: terminal failure', {
          error,
          sessionId: this._session.identity.sessionId,
        });
      },
    };

    this._engine = new ReconnectEngine(
      this.adapter,
      this._identity.current,
      this.config.replayConfig,
      callbacks,
      this.config.reconnectPolicy,
    );

    this._observability.trackSession(this._session);
  }

  private async _getAuthToken(): Promise<string> {
    if (this.config.authProvider) {
      return this.config.authProvider.getToken();
    }
    return '';
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Create a new RemoteSubstrate instance.
 *
 * @param config - Remote substrate configuration.
 * @param adapter - Optional transport adapter (can be attached later via `attach()`).
 * @returns A new RemoteSubstrate instance.
 *
 * @example
 * ```ts
 * const substrate = createRemoteSubstrate({
 *   endpoint: 'wss://remote.example.com/agent',
 *   identity: {
 *     sessionId: crypto.randomUUID(),
 *     taskId: crypto.randomUUID(),
 *     agentId: crypto.randomUUID(),
 *     createdAt: Date.now(),
 *     generation: 1,
 *   },
 * });
 *
 * substrate.attach(myTransportAdapter, storeCallbacks);
 * const connected = await substrate.connect();
 * ```
 */
export function createRemoteSubstrate(
  config: RemoteSubstrateConfig,
  adapter?: TransportAdapter,
): RemoteSubstrate {
  return new RemoteSubstrate(config, adapter ?? null);
}
