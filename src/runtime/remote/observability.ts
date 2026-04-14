/**
 * Remote Substrate — Observability Panel Data Provider
 *
 * Provides introspection data about remote connections for display in
 * diagnostic panels. Follows the same panel data provider pattern used
 * by the diagnostics subsystem (see src/runtime/diagnostics/).
 *
 * Unlike the diagnostics panels, RemoteObservabilityProvider is specialized
 * for remote transport state and does not subscribe to the general event bus.
 * It instead receives push updates from the RemoteSubstrate facade.
 */

import type { RemoteSession, RemoteTask, RemoteHealth, DurableIdentity } from './types.ts';
import { logger } from '../../utils/logger.ts';
import { summarizeError } from '../../utils/error-display.ts';

// ── Snapshot types ────────────────────────────────────────────────────────────

/**
 * A point-in-time snapshot of a single remote connection for panel rendering.
 */
export interface RemoteConnectionSnapshot {
  /** Local connection tracking ID. */
  readonly connectionId: string;
  /** Durable identity (stable IDs). */
  readonly identity: DurableIdentity;
  /** Remote endpoint address. */
  readonly endpoint: string;
  /** Current transport state string. */
  readonly transportState: string;
  /** Number of reconnect attempts since last success. */
  readonly reconnectAttempts: number;
  /** Epoch ms of last successful connection (undefined = never). */
  readonly lastConnectedAt: number | undefined;
  /** Current remote health status. */
  readonly health: RemoteHealth;
  /** Remote tasks currently tracked for this connection. */
  readonly tasks: readonly RemoteTaskSnapshot[];
  /** Number of messages sent. */
  readonly messagesSent: number;
  /** Number of messages received. */
  readonly messagesReceived: number;
  /** Last acknowledged message offset. */
  readonly lastAckedOffset: number;
  /** Last error message (undefined if healthy). */
  readonly lastError: string | undefined;
}

/**
 * Condensed view of a remote task for panel rendering.
 */
export interface RemoteTaskSnapshot {
  readonly taskId: string;
  readonly agentId: string;
  readonly title: string;
  readonly status: RemoteTask['status'];
  readonly updatedAt: number;
  readonly progress: number | undefined;
  readonly error: string | undefined;
}

/**
 * Aggregated observability snapshot across all remote connections.
 */
export interface RemoteObservabilitySnapshot {
  /** Epoch ms when this snapshot was taken. */
  readonly capturedAt: number;
  /** All tracked remote connections. */
  readonly connections: readonly RemoteConnectionSnapshot[];
  /** Total number of active connections. */
  readonly activeCount: number;
  /** Total messages sent across all connections. */
  readonly totalMessagesSent: number;
  /** Total messages received across all connections. */
  readonly totalMessagesReceived: number;
  /** Count of connections in terminal_failure state. */
  readonly failedCount: number;
}

// ── RemoteObservabilityProvider ───────────────────────────────────────────────

/**
 * RemoteObservabilityProvider — aggregates remote session state for panel rendering.
 *
 * Register active RemoteSessions via `trackSession()` and unregister via
 * `untrackSession()`. Subscribe to changes with `subscribe()`. Retrieve
 * point-in-time snapshots with `getSnapshot()`.
 *
 * @example
 * ```ts
 * const obs = new RemoteObservabilityProvider();
 * obs.trackSession(session);
 *
 * const unsubscribe = obs.subscribe(() => {
 *   const snap = obs.getSnapshot();
 *   renderRemotePanel(snap);
 * });
 *
 * // When session ends:
 * obs.untrackSession(session.connectionId);
 * unsubscribe();
 * ```
 */
export class RemoteObservabilityProvider {
  /** Sessions keyed by connectionId. */
  private readonly _sessions = new Map<string, RemoteSession>();
  /** Change subscribers. */
  private readonly _subscribers = new Set<() => void>();

  /**
   * Begin tracking a remote session.
   *
   * @param session - The remote session to track.
   */
  trackSession(session: RemoteSession): void {
    this._sessions.set(session.connectionId, session);
    this._notify();
  }

  /**
   * Update an existing session's state.
   *
   * Call this whenever the RemoteSubstrate mutates a session.
   *
   * @param session - Updated session snapshot.
   */
  updateSession(session: RemoteSession): void {
    if (this._sessions.has(session.connectionId)) {
      this._sessions.set(session.connectionId, session);
      this._notify();
    }
  }

  /**
   * Stop tracking a remote session.
   *
   * @param connectionId - The connectionId of the session to remove.
   */
  untrackSession(connectionId: string): void {
    if (this._sessions.delete(connectionId)) {
      this._notify();
    }
  }

  /**
   * Return a point-in-time snapshot of all tracked connections.
   *
   * @returns Frozen aggregated snapshot.
   */
  getSnapshot(): RemoteObservabilitySnapshot {
    const connections: RemoteConnectionSnapshot[] = [];
    let totalSent = 0;
    let totalReceived = 0;
    let failedCount = 0;

    for (const session of this._sessions.values()) {
      const conn = this._buildConnectionSnapshot(session);
      connections.push(conn);
      totalSent += session.messagesSent;
      totalReceived += session.messagesReceived;
      if (session.transportState === 'terminal_failure') failedCount++;
    }

    return Object.freeze({
      capturedAt: Date.now(),
      connections: Object.freeze(connections),
      activeCount: connections.filter(
        (c) => c.transportState !== 'terminal_failure' && c.transportState !== 'disconnected',
      ).length,
      totalMessagesSent: totalSent,
      totalMessagesReceived: totalReceived,
      failedCount,
    });
  }

  /**
   * Subscribe to observability data changes.
   *
   * @param callback - Invoked whenever the tracked session list or state changes.
   * @returns An unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => { this._subscribers.delete(callback); };
  }

  /**
   * Dispose this provider, clearing all sessions and subscribers.
   */
  dispose(): void {
    this._sessions.clear();
    this._subscribers.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _buildConnectionSnapshot(session: RemoteSession): RemoteConnectionSnapshot {
    const tasks: RemoteTaskSnapshot[] = [];
    for (const task of session.remoteTasks.values()) {
      tasks.push({
        taskId: task.taskId,
        agentId: task.agentId,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt,
        progress: task.progress,
        error: task.error,
      });
    }

    return Object.freeze({
      connectionId: session.connectionId,
      identity: session.identity,
      endpoint: session.endpoint,
      transportState: session.transportState,
      reconnectAttempts: session.reconnectAttempts,
      lastConnectedAt: session.lastConnectedAt,
      health: session.health,
      tasks: Object.freeze(tasks),
      messagesSent: session.messagesSent,
      messagesReceived: session.messagesReceived,
      lastAckedOffset: session.lastAckedOffset,
      lastError: session.lastError,
    });
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal — subscriber errors must not crash the provider
        logger.debug('RemoteObservabilityProvider: subscriber error', {
          err: summarizeError(err),
        });
      }
    }
  }
}
