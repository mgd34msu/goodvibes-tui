/**
 * Multi-session Orchestration — Cross-Session Task Registry
 *
 * Wraps SessionTaskGraph with persistence to
 * `.goodvibes/tui/sessions/task-graph.json` and reconnect/resume hydration.
 *
 * The registry is the single authoritative source for the cross-session task
 * graph within a process. All command handlers and sync integrations interact
 * with it via the `getSessionOrchestration()` singleton accessor.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'path';
import { logger } from '../../utils/logger.ts';
import { SessionTaskGraph } from './graph.ts';
import type {
  CrossSessionTaskRef,
  TaskHandoffRecord,
  CancellationRequest,
  CancellationResult,
  SessionTaskGraphSnapshot,
} from './types.ts';
import { makeRefKey } from './types.ts';
import type { TaskLifecycleState } from '../../runtime/store/domains/tasks.ts';

/** Current schema version for the persisted graph file. */
const GRAPH_SCHEMA_VERSION = 1;

// ── CrossSessionTaskRegistry ──────────────────────────────────────────────────

/**
 * CrossSessionTaskRegistry — persistent wrapper around `SessionTaskGraph`.
 *
 * Responsibilities:
 * - Load the graph from disk on construction (reconnect/resume hydration).
 * - Flush the graph to disk after every mutation.
 * - Expose a stable interface for command handlers and sync adapters.
 * - Generate unique handoff IDs.
 */
export class CrossSessionTaskRegistry {
  private readonly _graph: SessionTaskGraph;
  private readonly _graphPath: string;
  private readonly _dir: string;
  private _dirEnsured = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** @internal — exposed for _resetForTesting only. */
  _exitHandler: (() => void) | null = null;

  /**
   * @param baseDir - Project base directory (defaults to cwd).
   *   The graph is persisted at `<baseDir>/.goodvibes/tui/sessions/task-graph.json`.
   */
  public constructor(baseDir?: string) {
    this._dir = join(baseDir ?? process.cwd(), '.goodvibes', 'tui', 'sessions');
    this._graphPath = join(this._dir, 'task-graph.json');
    this._graph = new SessionTaskGraph();
    this._load();
    this._exitHandler = () => {
      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
        this._flushSync();
      }
    };
    process.on('exit', this._exitHandler);
  }

  // ── Task ref operations ───────────────────────────────────────────────────────

  /**
   * Link a task into the global graph — registers the task as a
   * cross-session ref and optionally adds a dependency edge.
   *
   * @param ref - The task ref to link.
   * @param dependsOn - Optional ref this task depends on.
   * @param reason - Optional reason for the dependency edge.
   * @returns Result of the link operation.
   */
  public linkTask(
    ref: CrossSessionTaskRef,
    dependsOn?: { sessionId: string; taskId: string },
    reason?: string,
  ): { ok: boolean; error?: string } {
    this._graph.upsertRef(ref);

    if (dependsOn) {
      const edgeResult = this._graph.addEdge(
        { sessionId: ref.sessionId, taskId: ref.taskId },
        dependsOn,
        reason,
      );
      if (!edgeResult.ok) {
        this._flush();
        return { ok: false, error: edgeResult.error };
      }
    }

    this._flush();
    return { ok: true };
  }

  /**
   * Update the status of a task ref.
   *
   * @param sessionId - Owning session.
   * @param taskId - Target task.
   * @param status - New lifecycle status.
   * @returns `true` if the status changed and was flushed.
   */
  public propagateStatus(
    sessionId: string,
    taskId: string,
    status: TaskLifecycleState,
  ): boolean {
    const changed = this._graph.propagateStatus(sessionId, taskId, status);
    if (changed) this._flush();
    return changed;
  }

  /**
   * Look up a ref by session + task ID.
   */
  public getRef(sessionId: string, taskId: string): CrossSessionTaskRef | undefined {
    return this._graph.getRef(sessionId, taskId);
  }

  /**
   * Return all refs in the graph.
   */
  public getAllRefs(): CrossSessionTaskRef[] {
    return this._graph.getAllRefs();
  }

  /**
   * Return all refs for a given session.
   */
  public getRefsBySession(sessionId: string): CrossSessionTaskRef[] {
    return this._graph.getRefsBySession(sessionId);
  }

  /**
   * Return all direct dependencies of a task.
   */
  public getDependencies(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    return this._graph.getDependencies(sessionId, taskId);
  }

  /**
   * Return all direct dependents of a task.
   */
  public getDependents(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    return this._graph.getDependents(sessionId, taskId);
  }

  // ── Handoff operations ────────────────────────────────────────────────────────

  /**
   * Initiate a task handoff from one session to another.
   *
   * Both sessions must have their task refs registered before calling this.
   * The originating task ref status is updated to 'blocked' (awaiting handoff).
   *
   * @param taskRef - The task being handed off.
   * @param fromSessionId - Source session.
   * @param toSessionId - Destination session.
   * @param reason - Optional human-readable reason.
   * @returns Result of the handoff operation.
   */
  public initiateHandoff(
    taskRef: { sessionId: string; taskId: string },
    fromSessionId: string,
    toSessionId: string,
    reason?: string,
  ): { ok: boolean; handoffId?: string; error?: string } {
    const ref = this._graph.getRef(taskRef.sessionId, taskRef.taskId);
    if (!ref) {
      return {
        ok: false,
        error: `Task ref not found: ${makeRefKey(taskRef.sessionId, taskRef.taskId)}. ` +
          'Register the task with /session link-task first.',
      };
    }

    const handoffId = crypto.randomUUID();
    const record: TaskHandoffRecord = {
      handoffId,
      taskRef: { sessionId: taskRef.sessionId, taskId: taskRef.taskId },
      fromSessionId,
      toSessionId,
      reason,
      initiatedAt: Date.now(),
      acknowledged: false,
    };

    this._graph.recordHandoff(record);

    // Mark the task as blocked while awaiting handoff acknowledgement
    this._graph.propagateStatus(taskRef.sessionId, taskRef.taskId, 'blocked');

    this._flush();
    return { ok: true, handoffId };
  }

  /**
   * Acknowledge a handoff from the destination session.
   *
   * @param handoffId - The handoff to acknowledge.
   * @returns `true` if the handoff was found and acknowledged.
   */
  public acknowledgeHandoff(handoffId: string): boolean {
    const ok = this._graph.acknowledgeHandoff(handoffId);
    if (ok) this._flush();
    return ok;
  }

  /**
   * Return all handoff records.
   */
  public getHandoffs(): TaskHandoffRecord[] {
    return this._graph.getHandoffs();
  }

  // ── Scoped cancellation ───────────────────────────────────────────────────────

  /**
   * Apply a scoped cancellation to the graph.
   *
   * @param request - The cancellation request.
   * @returns Result describing what was cancelled and what was skipped.
   */
  public cancel(request: CancellationRequest): CancellationResult {
    const result = this._graph.applyCancellation(request);
    if (result.ok && result.cancelled.length > 0) this._flush();
    return result;
  }

  // ── Snapshot / persistence ────────────────────────────────────────────────────

  /**
   * Take a snapshot of the current graph state.
   * Suitable for display (e.g. `/session graph`).
   */
  public snapshot(): SessionTaskGraphSnapshot {
    return this._graph.snapshot();
  }

  /**
   * Force a synchronous flush to disk.
   * Use on shutdown/dispose to ensure all pending data is written.
   */
  public flush(): void {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._flushSync();
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Load the persisted graph from disk and hydrate the in-memory graph.
   * Non-fatal: if the file is missing or malformed, the graph starts empty.
   */
  private _load(): void {
    if (!existsSync(this._graphPath)) return;

    try {
      const raw = readFileSync(this._graphPath, 'utf-8');
      const parsed = JSON.parse(raw) as SessionTaskGraphSnapshot;

      if (parsed.version !== GRAPH_SCHEMA_VERSION) {
        logger.debug('CrossSessionTaskRegistry: snapshot version mismatch, starting fresh', {
          expected: GRAPH_SCHEMA_VERSION,
          got: parsed.version,
        });
        return;
      }

      this._graph.hydrate(parsed);
      logger.debug('CrossSessionTaskRegistry: hydrated graph from disk', {
        path: this._graphPath,
      });
    } catch (e) {
      // Non-fatal: malformed or missing graph file — start with empty graph
      logger.debug('CrossSessionTaskRegistry: could not load task graph', {
        path: this._graphPath,
        error: (e as Error).message,
      });
    }
  }

  /**
   * Flush the current graph snapshot to disk.
   * Non-fatal: if the write fails, logs a debug message and continues.
   */
  private _flush(): void {
    this._scheduledFlush();
  }

  /** Schedule a debounced async write (coalesces rapid successive mutations). */
  private _scheduledFlush(): void {
    if (this._flushTimer !== null) return;
    this._flushTimer = setTimeout(async () => {
      this._flushTimer = null;
      try {
        if (!this._dirEnsured) {
          mkdirSync(this._dir, { recursive: true });
          this._dirEnsured = true;
        }
        await writeFile(this._graphPath, JSON.stringify(this._graph.snapshot(), null, 2), 'utf-8');
      } catch (e) {
        logger.warn('CrossSessionTaskRegistry: failed to flush task graph', {
          path: this._graphPath,
          error: (e as Error).message,
        });
      }
    }, 100);
  }

  /** Perform a synchronous write — used by shutdown/dispose and flush(). */
  private _flushSync(): void {
    try {
      if (!this._dirEnsured) {
        mkdirSync(this._dir, { recursive: true });
        this._dirEnsured = true;
      }
      const snap = this._graph.snapshot();
      writeFileSync(this._graphPath, JSON.stringify(snap, null, 2), 'utf-8');
    } catch (e) {
      // Non-fatal: failed to persist graph — in-memory graph remains authoritative
      logger.debug('CrossSessionTaskRegistry: failed to flush task graph', {
        path: this._graphPath,
        error: (e as Error).message,
      });
    }
  }
}

// ── Singleton accessor ────────────────────────────────────────────────────────

let _instance: CrossSessionTaskRegistry | undefined;

/**
 * Lazy singleton accessor for CrossSessionTaskRegistry.
 * Avoids re-instantiation on every command invocation.
 */
export function getSessionOrchestration(): CrossSessionTaskRegistry {
  if (!_instance) _instance = new CrossSessionTaskRegistry();
  return _instance;
}

/**
 * Reset the singleton instance — for use in tests only.
 * Clears the cached instance so the next call to getSessionOrchestration()
 * constructs a fresh registry.
 */
export function _resetForTesting(): void {
  if (_instance?._exitHandler) process.removeListener('exit', _instance._exitHandler);
  _instance = undefined;
}
