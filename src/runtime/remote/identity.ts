/**
 * Remote Substrate — Durable Identity Manager
 *
 * Implements v3 Section 10.1: globally unique, stable identifiers for
 * sessionId, taskId, and agentId that survive transport changes and reconnects.
 *
 * The identity manager maintains the canonical set of IDs for a remote
 * substrate instance. Reconnects do not change these IDs — only explicit
 * refresh calls (for new tasks) increment the generation counter.
 */

import { randomUUID } from 'node:crypto';
import type { DurableIdentity } from './types.ts';
import { logger } from '../../utils/logger.ts';

/** Serializable snapshot for persistence across process restarts. */
export interface IdentitySnapshot {
  readonly sessionId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly createdAt: number;
  readonly generation: number;
}

/**
 * DurableIdentityManager — creates and maintains stable IDs across reconnects.
 *
 * Once created, the sessionId is permanent for the lifetime of this manager.
 * The taskId and agentId can be refreshed (incrementing generation) when
 * starting a new remote task, but remain stable across reconnects within
 * the same task.
 *
 * @example
 * ```ts
 * const identity = new DurableIdentityManager();
 * // sessionId/taskId/agentId are stable — safe to pass across reconnects
 * const { sessionId, taskId } = identity.current;
 *
 * // After reconnect — same IDs
 * await reconnect();
 * identity.current.sessionId === sessionId; // true
 *
 * // Starting a new task — refresh task/agent IDs
 * identity.refreshTaskIdentity();
 * identity.current.taskId !== taskId; // true
 * ```
 */
export class DurableIdentityManager {
  private _current: DurableIdentity;

  constructor(snapshot?: IdentitySnapshot) {
    if (snapshot) {
      this._current = Object.freeze({
        sessionId: snapshot.sessionId,
        taskId: snapshot.taskId,
        agentId: snapshot.agentId,
        createdAt: snapshot.createdAt,
        generation: snapshot.generation,
      });
      logger.debug('DurableIdentityManager: restored from snapshot', {
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
      });
    } else {
      this._current = Object.freeze({
        sessionId: randomUUID(),
        taskId: randomUUID(),
        agentId: randomUUID(),
        createdAt: Date.now(),
        generation: 1,
      });
      logger.debug('DurableIdentityManager: created new identity', {
        sessionId: this._current.sessionId,
      });
    }
  }

  /**
   * The current durable identity snapshot.
   *
   * This reference is stable across reconnects — the same object is returned
   * until `refreshTaskIdentity()` is called.
   */
  get current(): DurableIdentity {
    return this._current;
  }

  /**
   * Refresh the task and agent identifiers for a new remote task.
   *
   * The sessionId is preserved. The generation counter increments.
   * Call this when starting a new task on the remote substrate —
   * not when reconnecting to an existing task.
   *
   * @returns The new durable identity.
   */
  refreshTaskIdentity(): DurableIdentity {
    const prev = this._current;
    this._current = Object.freeze({
      sessionId: prev.sessionId,
      taskId: randomUUID(),
      agentId: randomUUID(),
      createdAt: prev.createdAt,
      generation: prev.generation + 1,
    });
    logger.debug('DurableIdentityManager: task identity refreshed', {
      sessionId: this._current.sessionId,
      generation: this._current.generation,
    });
    return this._current;
  }

  /**
   * Serialize the current identity for persistence.
   *
   * Store the snapshot and pass it to the constructor on restart to
   * restore identity continuity across process restarts.
   *
   * @returns A plain-object snapshot safe for JSON serialization.
   */
  toSnapshot(): IdentitySnapshot {
    return {
      sessionId: this._current.sessionId,
      taskId: this._current.taskId,
      agentId: this._current.agentId,
      createdAt: this._current.createdAt,
      generation: this._current.generation,
    };
  }

  /**
   * Restore identity from a plain snapshot object.
   *
   * Use this when rehydrating a remote substrate after a process restart.
   * This is equivalent to constructing with a snapshot but can be called
   * on an existing instance.
   *
   * @param snapshot - Previously serialized identity snapshot.
   */
  restoreFromSnapshot(snapshot: IdentitySnapshot): void {
    this._current = Object.freeze({
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      agentId: snapshot.agentId,
      createdAt: snapshot.createdAt,
      generation: snapshot.generation,
    });
    logger.debug('DurableIdentityManager: identity restored from snapshot', {
      sessionId: snapshot.sessionId,
      generation: snapshot.generation,
    });
  }
}
