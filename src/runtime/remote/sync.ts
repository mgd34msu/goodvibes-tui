/**
 * Remote Substrate — State Sync
 *
 * Implements v3 Section 10.4: mirrors remote task and health state into
 * local runtime store domains (AcpDomainState, TaskDomainState).
 *
 * The sync layer is a one-way bridge: remote data flows into local store
 * domains via the provided mutation callbacks. The store remains the
 * single source of truth for local rendering — remote state is a projection.
 */

import type { RemoteTask, RemoteHealth, RemoteSession } from './types.ts';
import type { AcpDomainState, AcpConnection } from '../store/domains/acp.ts';
import type { RuntimeTask, TaskDomainState } from '../store/domains/tasks.ts';
import { logger } from '../../utils/logger.ts';

// ── Mutation callbacks (injected by the store layer) ─────────────────────────

/**
 * Callbacks supplied by the runtime store to apply state mutations.
 *
 * The sync layer never touches the store directly — it calls these
 * callbacks and lets the store manage its own invariants.
 */
export interface SyncStoreCallbacks {
  /**
   * Update ACP connection entry for the remote session.
   *
   * @param agentId - Durable agent ID of the remote connection.
   * @param patch - Partial AcpConnection fields to update.
   */
  updateAcpConnection(
    agentId: string,
    patch: Partial<AcpConnection>,
  ): void;

  /**
   * Upsert a remote task into the tasks domain.
   *
   * @param task - Remote task snapshot to sync.
   */
  upsertRemoteTask(task: RuntimeTask): void;

  /**
   * Mark a remote task as terminal in the tasks domain.
   *
   * @param taskId - Task ID to finalize.
   * @param status - Terminal status.
   * @param error - Optional error message.
   */
  finalizeRemoteTask(
    taskId: string,
    status: Extract<RuntimeTask['status'], 'completed' | 'failed' | 'cancelled'>,
    error?: string,
  ): void;
}

// ── RemoteStateSyncer ─────────────────────────────────────────────────────────

/**
 * RemoteStateSyncer — applies incoming remote state snapshots into local domains.
 *
 * Owns the translation from `RemoteTask`/`RemoteHealth` types (remote-facing)
 * into `RuntimeTask` / ACP domain types (local store-facing).
 *
 * @example
 * ```ts
 * const syncer = new RemoteStateSyncer(storeCallbacks);
 *
 * // Called by the transport layer when a STATE_SNAPSHOT message arrives:
 * syncer.syncSnapshot(session, incomingTasks, incomingHealth);
 *
 * // Called for incremental task updates:
 * syncer.syncTaskUpdate(session, remoteTask);
 * ```
 */
export class RemoteStateSyncer {
  constructor(private readonly callbacks: SyncStoreCallbacks) {}

  /**
   * Sync a full remote state snapshot into local store domains.
   *
   * Called when a STATE_SNAPSHOT data message arrives after reconnect sync.
   * Applies all tasks and the health status in a single pass.
   *
   * @param session - Current remote session (provides identity context).
   * @param tasks - Remote tasks from the snapshot.
   * @param health - Remote health snapshot.
   */
  syncSnapshot(
    session: RemoteSession,
    tasks: readonly RemoteTask[],
    health: RemoteHealth,
  ): void {
    logger.debug('RemoteStateSyncer.syncSnapshot: applying state snapshot', {
      taskCount: tasks.length,
      healthStatus: health.status,
      sessionId: session.identity.sessionId,
    });

    for (const task of tasks) {
      this._applyRemoteTask(session, task);
    }

    this._applyHealth(session, health);
  }

  /**
   * Sync an incremental task update.
   *
   * Called when a TASK_UPDATE or TASK_SUBMIT data message arrives.
   *
   * @param session - Current remote session.
   * @param task - Updated remote task.
   */
  syncTaskUpdate(session: RemoteSession, task: RemoteTask): void {
    this._applyRemoteTask(session, task);
  }

  /**
   * Sync an incremental health update.
   *
   * Called when a HEALTH_REPORT data message arrives.
   *
   * @param session - Current remote session.
   * @param health - Updated health snapshot.
   */
  syncHealthUpdate(session: RemoteSession, health: RemoteHealth): void {
    this._applyHealth(session, health);
  }

  /**
   * Sync transport state change into the ACP connection entry.
   *
   * Called by the reconnect engine on every state transition.
   *
   * @param session - Current remote session.
   */
  syncTransportState(session: RemoteSession): void {
    const { identity, transportState, lastError, reconnectAttempts, messagesSent, messagesReceived } = session;

    this.callbacks.updateAcpConnection(identity.agentId, {
      transportState,
      lastError,
      errorCount: reconnectAttempts,
      messageCount: messagesSent + messagesReceived,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _applyRemoteTask(session: RemoteSession, remote: RemoteTask): void {
    const isTerminal = (
      remote.status === 'completed' ||
      remote.status === 'failed' ||
      remote.status === 'cancelled'
    );

    if (isTerminal) {
      const terminalStatus = remote.status as Extract<RuntimeTask['status'], 'completed' | 'failed' | 'cancelled'>;
      this.callbacks.finalizeRemoteTask(remote.taskId, terminalStatus, remote.error);
    } else {
      const runtimeTask: RuntimeTask = {
        id: remote.taskId,
        kind: 'acp',
        title: remote.title,
        status: remote.status,
        owner: remote.agentId,
        cancellable: remote.status === 'queued' || remote.status === 'running',
        childTaskIds: [],
        queuedAt: remote.updatedAt,
        startedAt: remote.status !== 'queued' ? remote.updatedAt : undefined,
        endedAt: undefined,
        error: remote.error,
        correlationId: session.identity.sessionId,
      };
      this.callbacks.upsertRemoteTask(runtimeTask);
    }
  }

  private _applyHealth(session: RemoteSession, health: RemoteHealth): void {
    // Map remote health status to ACP transport state
    const transportState = (() => {
      switch (health.status) {
        case 'healthy': return 'connected' as const;
        case 'degraded': return 'degraded' as const;
        case 'unreachable': return 'reconnecting' as const;
      }
    })();

    this.callbacks.updateAcpConnection(session.identity.agentId, {
      transportState,
      lastError: health.degradedReason,
    });
  }
}

// ── No-op sync callbacks (for testing or disabled sync) ──────────────────────

/**
 * Returns a no-op SyncStoreCallbacks implementation.
 * Useful when the store is not yet initialized or sync is disabled.
 */
export function createNoOpSyncCallbacks(): SyncStoreCallbacks {
  return {
    updateAcpConnection: (_agentId, _patch) => { /* no-op */ },
    upsertRemoteTask: (_task) => { /* no-op */ },
    finalizeRemoteTask: (_taskId, _status, _error) => { /* no-op */ },
  };
}

// ── Utility: build initial AcpConnection for a remote session ─────────────────

/**
 * Build an initial AcpConnection domain entry from a remote session.
 *
 * Call this when registering a new remote connection with the ACP store domain.
 *
 * @param session - Remote session snapshot.
 * @param label - Human-readable connection label.
 * @returns An AcpConnection suitable for inserting into AcpDomainState.connections.
 */
export function buildAcpConnectionEntry(
  session: RemoteSession,
  label: string,
): AcpConnection {
  return {
    agentId: session.identity.agentId,
    label,
    transportState: session.transportState,
    connectedAt: session.lastConnectedAt,
    completing: false,
    messageCount: session.messagesSent + session.messagesReceived,
    errorCount: session.reconnectAttempts,
    lastError: session.lastError,
    taskId: session.identity.taskId,
  };
}

// ── Utility: domain state accessors ──────────────────────────────────────────

/**
 * Count active remote connections in an ACP domain state snapshot.
 *
 * @param state - ACP domain state snapshot.
 * @returns Number of connections that are not yet completing.
 */
export function countActiveRemoteConnections(state: AcpDomainState): number {
  return state.activeConnectionIds.length;
}

/**
 * Extract remote task IDs from a tasks domain snapshot.
 *
 * @param state - Tasks domain state snapshot.
 * @returns Array of task IDs whose kind === 'acp'.
 */
export function extractRemoteTaskIds(state: TaskDomainState): string[] {
  const ids: string[] = [];
  for (const [id, task] of state.tasks) {
    if (task.kind === 'acp') ids.push(id);
  }
  return ids;
}
