/**
 * Multi-session Orchestration — Session Task Graph
 *
 * Implements the in-memory cross-session task graph with:
 * - Global task reference registration and status propagation
 * - Dependency edge tracking
 * - Handoff record management
 * - Subtree traversal for scoped cancellation
 * - Snapshot serialization for reconnect/resume consistency
 */

import type {
  CrossSessionTaskRef,
  TaskDependencyEdge,
  TaskHandoffRecord,
  CancellationRequest,
  CancellationResult,
  SessionTaskGraphSnapshot,
} from './types.ts';
import { makeRefKey } from './types.ts';
import type { TaskLifecycleState } from '../../runtime/store/domains/tasks.ts';
import { logger } from '../../utils/logger.ts';

// ── Module-level constants ────────────────────────────────────────────────────

/** Terminal states that cannot be cancelled or transitioned further. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

// ── SessionTaskGraph ──────────────────────────────────────────────────────────

/**
 * SessionTaskGraph — the central in-memory cross-session task graph.
 *
 * All mutations are synchronous and produce no external side effects —
 * callers are responsible for persisting snapshots via SessionTaskGraphRegistry.
 *
 * Invariants:
 * - Ref keys are unique per (sessionId, taskId) pair.
 * - Edges reference only registered refs.
 * - Handoff IDs are globally unique within the graph lifetime.
 * - The graph is acyclic (cycle detection is performed on `addEdge`).
 */
export class SessionTaskGraph {
  /** Primary ref store keyed by makeRefKey(sessionId, taskId). */
  private readonly _refs = new Map<string, CrossSessionTaskRef>();

  /** Dependency edges: fromKey → Set<toKey> */
  private readonly _deps = new Map<string, Set<string>>();

  /** Reverse edges: toKey → Set<fromKey> (dependents of a given task). */
  private readonly _rdeps = new Map<string, Set<string>>();

  /** Handoff records keyed by handoffId. */
  private readonly _handoffs = new Map<string, TaskHandoffRecord>();

  /** All stored edges in insertion order for snapshot serialization. */
  private readonly _edgeList: TaskDependencyEdge[] = [];

  // ── Ref management ───────────────────────────────────────────────────────────

  /**
   * Register a new cross-session task ref or update an existing one.
   *
   * If a ref with the same key already exists, only mutable fields
   * (status, updatedAt, label) are patched — immutable identity fields
   * (sessionId, taskId, createdAt) are preserved.
   *
   * @param ref - The ref to register or update.
   * @returns The ref as stored (after any patch).
   */
  public upsertRef(ref: CrossSessionTaskRef): CrossSessionTaskRef {
    const key = makeRefKey(ref.sessionId, ref.taskId);
    const existing = this._refs.get(key);

    if (existing) {
      // Patch mutable fields only; replace the map entry with a new spread copy
      const updated: CrossSessionTaskRef = {
        ...existing,
        status: ref.status,
        updatedAt: ref.updatedAt,
        ...(ref.label !== undefined ? { label: ref.label } : {}),
      };
      this._refs.set(key, updated);
      logger.debug('SessionTaskGraph.upsertRef: updated', { key, status: ref.status });
      return this._refs.get(key)!;
    }

    this._refs.set(key, { ...ref });
    logger.debug('SessionTaskGraph.upsertRef: registered', { key });
    return this._refs.get(key)!;
  }

  /**
   * Retrieve a ref by session + task ID.
   *
   * @returns The ref if found, or `undefined`.
   */
  public getRef(sessionId: string, taskId: string): CrossSessionTaskRef | undefined {
    return this._refs.get(makeRefKey(sessionId, taskId));
  }

  /**
   * Return all refs owned by a given session.
   *
   * @param sessionId - The owning session ID.
   * @returns Array of refs (may be empty).
   */
  public getRefsBySession(sessionId: string): CrossSessionTaskRef[] {
    const results: CrossSessionTaskRef[] = [];
    for (const ref of this._refs.values()) {
      if (ref.sessionId === sessionId) results.push(ref);
    }
    return results;
  }

  /**
   * Return all currently registered refs.
   */
  public getAllRefs(): CrossSessionTaskRef[] {
    return Array.from(this._refs.values());
  }

  /**
   * Propagate a status update to a ref.
   *
   * Idempotent: updating to the same status is a no-op.
   *
   * @param sessionId - Owning session.
   * @param taskId - Target task.
   * @param status - New lifecycle status.
   * @returns `true` if the status changed; `false` if ref not found or no change.
   */
  public propagateStatus(
    sessionId: string,
    taskId: string,
    status: TaskLifecycleState,
  ): boolean {
    const ref = this.getRef(sessionId, taskId);
    if (!ref) return false;
    if (ref.status === status) return false;
    const key = makeRefKey(sessionId, taskId);
    const updated = { ...ref, status, updatedAt: Date.now() };
    this._refs.set(key, updated);
    logger.debug('SessionTaskGraph.propagateStatus', { sessionId, taskId, status });
    return true;
  }

  // ── Dependency edges ─────────────────────────────────────────────────────────

  /**
   * Add a dependency edge: `from` depends on `to`.
   *
   * Both refs must already be registered. Adding a duplicate edge is a no-op.
   *
   * @param from - The dependent task.
   * @param to - The dependency.
   * @param reason - Optional human-readable reason.
   * @returns `{ ok: true }` on success, `{ ok: false, error }` on failure.
   */
  public addEdge(
    from: { sessionId: string; taskId: string },
    to: { sessionId: string; taskId: string },
    reason?: string,
  ): { ok: boolean; error?: string } {
    const fromKey = makeRefKey(from.sessionId, from.taskId);
    const toKey = makeRefKey(to.sessionId, to.taskId);

    if (!this._refs.has(fromKey)) {
      return { ok: false, error: `Ref not found: ${fromKey}` };
    }
    if (!this._refs.has(toKey)) {
      return { ok: false, error: `Ref not found: ${toKey}` };
    }
    if (fromKey === toKey) {
      return { ok: false, error: 'Self-dependency is not allowed' };
    }

    // Cycle detection — would adding fromKey→toKey create a cycle?
    if (this._pathExists(toKey, fromKey)) {
      return { ok: false, error: `Adding this dependency would create a cycle` };
    }

    // Check for duplicate
    const existing = this._deps.get(fromKey);
    if (existing?.has(toKey)) {
      return { ok: true }; // idempotent
    }

    // Forward edge
    if (!this._deps.has(fromKey)) this._deps.set(fromKey, new Set());
    this._deps.get(fromKey)!.add(toKey);

    // Reverse edge
    if (!this._rdeps.has(toKey)) this._rdeps.set(toKey, new Set());
    this._rdeps.get(toKey)!.add(fromKey);

    const edge: TaskDependencyEdge = {
      fromRef: { sessionId: from.sessionId, taskId: from.taskId },
      toRef: { sessionId: to.sessionId, taskId: to.taskId },
      linkedAt: Date.now(),
      reason,
    };
    this._edgeList.push(edge);

    logger.debug('SessionTaskGraph.addEdge', { fromKey, toKey });
    return { ok: true };
  }

  /**
   * Returns all direct dependencies of a task (tasks it depends on).
   *
   * @param sessionId - Owning session.
   * @param taskId - Target task.
   * @returns Array of refs this task depends on.
   */
  public getDependencies(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    const key = makeRefKey(sessionId, taskId);
    const keys = this._deps.get(key);
    if (!keys) return [];
    return this._refsForKeys(keys);
  }

  /**
   * Returns all direct dependents of a task (tasks that depend on it).
   *
   * @param sessionId - Owning session.
   * @param taskId - Target task.
   * @returns Array of refs that depend on this task.
   */
  public getDependents(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    const key = makeRefKey(sessionId, taskId);
    const keys = this._rdeps.get(key);
    if (!keys) return [];
    return this._refsForKeys(keys);
  }

  /**
   * Collect all refs in the transitive dependent subtree of a task
   * (the task itself plus all tasks that transitively depend on it).
   *
   * Used for `subtree` scoped cancellation.
   *
   * @param sessionId - Root session.
   * @param taskId - Root task.
   * @returns Array of refs in BFS order, root first.
   */
  public collectSubtree(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    const rootKey = makeRefKey(sessionId, taskId);
    const root = this._refs.get(rootKey);
    if (!root) return [];

    const visited = new Set<string>([rootKey]);
    const queue: string[] = [rootKey];
    const result: CrossSessionTaskRef[] = [root];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = this._rdeps.get(current);
      if (!dependents) continue;

      for (const depKey of dependents) {
        if (!visited.has(depKey)) {
          visited.add(depKey);
          queue.push(depKey);
          const ref = this._refs.get(depKey);
          if (ref) result.push(ref);
        }
      }
    }

    return result;
  }

  // ── Handoffs ──────────────────────────────────────────────────────────────────

  /**
   * Record a task handoff between sessions.
   *
   * @param record - The handoff to record.
   */
  public recordHandoff(record: TaskHandoffRecord): void {
    this._handoffs.set(record.handoffId, record);
    logger.debug('SessionTaskGraph.recordHandoff', { handoffId: record.handoffId });
  }

  /**
   * Acknowledge a handoff (mark it as received by the destination session).
   *
   * @param handoffId - The handoff to acknowledge.
   * @returns `true` if found and updated; `false` if not found.
   */
  public acknowledgeHandoff(handoffId: string): boolean {
    const record = this._handoffs.get(handoffId);
    if (!record) return false;
    const updated = { ...record, acknowledged: true, acknowledgedAt: Date.now() };
    this._handoffs.set(handoffId, updated);
    return true;
  }

  /**
   * Returns all handoff records.
   */
  public getHandoffs(): TaskHandoffRecord[] {
    return Array.from(this._handoffs.values());
  }

  /**
   * Returns handoffs targeting or originating from a given session.
   *
   * @param sessionId - The session to filter by.
   */
  public getHandoffsForSession(sessionId: string): TaskHandoffRecord[] {
    const result: TaskHandoffRecord[] = [];
    for (const h of this._handoffs.values()) {
      if (h.fromSessionId === sessionId || h.toSessionId === sessionId) {
        result.push(h);
      }
    }
    return result;
  }

  // ── Scoped cancellation ───────────────────────────────────────────────────────

  /**
   * Apply a scoped cancellation request to the graph.
   *
   * Updates the status of all targeted refs to 'cancelled'. This method
   * only mutates the in-memory graph — the caller is responsible for
   * propagating the cancellation to the actual task managers.
   *
   * @param request - The cancellation request.
   * @returns Result describing what was cancelled and what was skipped.
   */
  public applyCancellation(request: CancellationRequest): CancellationResult {
    const targets: CrossSessionTaskRef[] = [];

    switch (request.scope) {
      case 'task': {
        if (!request.taskId) {
          return { ok: false, cancelled: [], skipped: [], error: 'taskId required for task scope' };
        }
        const ref = this.getRef(request.sessionId, request.taskId);
        if (ref) targets.push(ref);
        break;
      }

      case 'subtree': {
        if (!request.taskId) {
          return { ok: false, cancelled: [], skipped: [], error: 'taskId required for subtree scope' };
        }
        targets.push(...this.collectSubtree(request.sessionId, request.taskId));
        break;
      }

      case 'session': {
        targets.push(...this.getRefsBySession(request.sessionId));
        break;
      }
    }

    if (targets.length === 0) {
      return {
        ok: false,
        cancelled: [],
        skipped: [],
        error: `No tasks found for scope=${request.scope} sessionId=${request.sessionId}${
          request.taskId ? ` taskId=${request.taskId}` : ''
        }`,
      };
    }

    const cancelled: CancellationResult['cancelled'] = [];
    const skipped: CancellationResult['skipped'] = [];

    for (const ref of targets) {
      const terminal = TERMINAL_STATES.has(ref.status);
      if (terminal) {
        skipped.push({ sessionId: ref.sessionId, taskId: ref.taskId, title: ref.title, reason: `already ${ref.status}` });
        continue;
      }
      const refKey = makeRefKey(ref.sessionId, ref.taskId);
      const updated = { ...ref, status: 'cancelled' as const, updatedAt: Date.now() };
      this._refs.set(refKey, updated);
      cancelled.push({ sessionId: ref.sessionId, taskId: ref.taskId, title: ref.title });
    }

    logger.debug('SessionTaskGraph.applyCancellation', {
      scope: request.scope,
      cancelled: cancelled.length,
      skipped: skipped.length,
    });

    return { ok: true, cancelled, skipped };
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────────

  /**
   * Take a snapshot of the current graph state for persistence or display.
   *
   * @returns A `SessionTaskGraphSnapshot` with all refs, edges, and handoffs.
   */
  public snapshot(): SessionTaskGraphSnapshot {
    const refs: Record<string, CrossSessionTaskRef> = {};
    for (const [key, ref] of this._refs) {
      refs[key] = { ...ref };
    }

    return {
      version: 1,
      snapshotAt: Date.now(),
      refs,
      edges: this._edgeList.map((e) => ({
        ...e,
        fromRef: { ...e.fromRef },
        toRef: { ...e.toRef },
      })),
      handoffs: Array.from(this._handoffs.values()).map((h) => ({ ...h })),
    };
  }

  /**
   * Hydrate the graph from a persisted snapshot.
   *
   * Existing in-memory state is preserved; snapshot entries are upserted.
   * This allows safe re-hydration on reconnect/resume without data loss.
   *
   * @param snap - The snapshot to hydrate from.
   */
  public hydrate(snap: SessionTaskGraphSnapshot): void {
    for (const ref of Object.values(snap.refs)) {
      this.upsertRef(ref);
    }

    for (const edge of snap.edges) {
      this.addEdge(edge.fromRef, edge.toRef, edge.reason);
    }

    for (const handoff of snap.handoffs) {
      if (!this._handoffs.has(handoff.handoffId)) {
        this._handoffs.set(handoff.handoffId, { ...handoff });
      }
    }

    logger.debug('SessionTaskGraph.hydrate', {
      refs: Object.keys(snap.refs).length,
      edges: snap.edges.length,
      handoffs: snap.handoffs.length,
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * BFS check: is there any path from `startKey` to `targetKey`?
   * Used for cycle detection before adding a new edge.
   */
  private _pathExists(startKey: string, targetKey: string): boolean {
    const visited = new Set<string>();
    const queue: string[] = [startKey];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetKey) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = this._deps.get(current);
      if (deps) {
        for (const dep of deps) {
          if (!visited.has(dep)) queue.push(dep);
        }
      }
    }

    return false;
  }

  /**
   * Resolve a set of ref keys to their corresponding CrossSessionTaskRef objects.
   * Silently skips any keys that are no longer present in the map.
   */
  private _refsForKeys(keys: Set<string>): CrossSessionTaskRef[] {
    const result: CrossSessionTaskRef[] = [];
    for (const key of keys) {
      const ref = this._refs.get(key);
      if (ref) result.push(ref);
    }
    return result;
  }
}
