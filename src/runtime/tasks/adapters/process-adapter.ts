/**
 * ProcessTaskAdapter — bridges ProcessManager background processes into the
 * unified RuntimeTask registry.
 *
 * Each spawned background process gets a corresponding RuntimeTask of kind
 * 'exec'. The adapter tracks the pid→taskId mapping and reconciles state
 * on demand via sync().
 *
 * NOTE: This adapter writes directly to the Zustand store for performance,
 * bypassing TaskManager. Lifecycle validation is the caller's responsibility.
 * This is intentional — adapters are authoritative sources for their subsystem.
 */

import { randomUUID } from 'node:crypto';
import type { StoreApi } from 'zustand';
import type { RuntimeState } from '../../store/state.ts';
import type { RuntimeTask } from '../../store/domains/tasks.ts';
import { ProcessManager } from '../../../tools/shared/process-manager.ts';

/** Owner context supplied when wrapping a process. */
export interface ProcessOwner {
  /** Session ID that spawned this process. */
  sessionId: string;
  /** Optional agent ID that owns this process. */
  agentId?: string;
}

/**
 * Bridges ProcessManager background processes into the RuntimeTask registry.
 *
 * @example
 * ```ts
 * const adapter = new ProcessTaskAdapter(store);
 * const taskId = adapter.wrapProcess(proc.pid, 'npm run build', { sessionId: 'sess_1' });
 * // later...
 * adapter.handleProcessExit(proc.pid, 0);
 * ```
 */
export class ProcessTaskAdapter {
  /** Maps process internal ID (bg_N_ts) → task ID. */
  private readonly _idToTask = new Map<string, string>();
  /** Maps task ID → process internal ID. */
  private readonly _taskToId = new Map<string, string>();
  /** Maps pid → process internal ID (for exit handling). */
  private readonly _pidToId = new Map<number, string>();

  private readonly _manager: ProcessManager;

  constructor(
    private readonly _store: StoreApi<RuntimeState>,
    manager?: ProcessManager,
  ) {
    this._manager = manager ?? ProcessManager.getInstance();
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Wrap a spawned process as a RuntimeTask.
   *
   * @param processId - The ProcessManager internal ID (process_id from spawn result).
   * @param pid - OS process ID.
   * @param command - The shell command string for display.
   * @param owner - Session/agent that owns this process.
   * @returns The new task ID.
   */
  wrapProcess(
    processId: string,
    pid: number,
    command: string,
    owner: ProcessOwner,
  ): string {
    // Idempotent: if already wrapped, return existing task ID
    const existing = this._idToTask.get(processId);
    if (existing !== undefined) return existing;

    const taskId = randomUUID();
    const now = Date.now();

    const task: RuntimeTask = {
      id: taskId,
      kind: 'exec',
      title: command.length > 80 ? `${command.slice(0, 77)}...` : command,
      description: command,
      status: 'running',
      owner: owner.agentId ?? owner.sessionId,
      cancellable: true,
      childTaskIds: [],
      queuedAt: now,
      startedAt: now,
      correlationId: owner.sessionId,
      turnId: owner.agentId,
    };

    this._idToTask.set(processId, taskId);
    this._taskToId.set(taskId, processId);
    this._pidToId.set(pid, processId);

    this._upsertTask(task);
    return taskId;
  }

  /**
   * Update task status when a process exits.
   *
   * @param pid - OS process ID that exited.
   * @param exitCode - Process exit code (0 = success).
   */
  handleProcessExit(pid: number, exitCode: number): void {
    const processId = this._pidToId.get(pid);
    if (processId === undefined) return;

    const taskId = this._idToTask.get(processId);
    if (taskId === undefined) return;

    this._pidToId.delete(pid);

    this._transitionTask(taskId, exitCode === 0 ? 'completed' : 'failed', {
      exitCode,
      error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
    });
  }

  /**
   * Cancel a process task by task ID.
   * Stops the underlying process via ProcessManager and marks the task cancelled.
   *
   * @param taskId - The RuntimeTask ID to cancel.
   */
  cancelProcess(taskId: string): void {
    const processId = this._taskToId.get(taskId);
    if (processId === undefined) return;

    // Look up the pid before stopping so we can clean up _pidToId
    const entry = this._manager.getStatus(processId);
    this._manager.stop(processId);
    if (entry !== undefined) {
      this._pidToId.delete(entry.pid);
    }
    this._transitionTask(taskId, 'cancelled', {});
  }

  /**
   * Reconcile adapter state with the RuntimeTask registry.
   *
   * Scans all ProcessManager processes:
   * - Wraps any un-tracked processes as new tasks (with a fallback owner).
   * - Marks completed (done) processes as completed or failed in the task store.
   * - Removes task mappings for processes that have been cleaned up.
   *
   * @param defaultOwner - Owner context used when auto-wrapping unknown processes.
   */
  sync(defaultOwner: ProcessOwner = { sessionId: 'system' }): void {
    const liveProcesses = this._manager.list();
    const liveIds = new Set(liveProcesses.map((p) => p.id));

    // Handle processes not yet tracked
    for (const proc of liveProcesses) {
      if (!this._idToTask.has(proc.id)) {
        // Use the real pid from list() for accurate _pidToId tracking
        this.wrapProcess(proc.id, proc.pid, proc.cmd, defaultOwner);
      }

      // Check if the process has finished
      const entry = this._manager.getStatus(proc.id);
      if (entry?.done) {
        const taskId = this._idToTask.get(proc.id);
        if (taskId !== undefined) {
          const exitCode = entry.exitCode ?? 1;
          this._transitionTask(taskId, exitCode === 0 ? 'completed' : 'failed', {
            exitCode,
            error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
          });
        }
      }
    }

    // Clean up stale mappings for processes no longer tracked by the manager
    const staleProcessIds: string[] = [];
    for (const [processId] of this._idToTask.entries()) {
      if (!liveIds.has(processId)) staleProcessIds.push(processId);
    }
    for (const processId of staleProcessIds) {
      const taskId = this._idToTask.get(processId)!;
      this._idToTask.delete(processId);
      this._taskToId.delete(taskId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _upsertTask(task: RuntimeTask): void {
    this._store.setState((state) => {
      const tasks = new Map(state.tasks.tasks);
      tasks.set(task.id, task);

      const isRunning = task.status === 'running';
      const isQueued = task.status === 'queued';

      return {
        tasks: {
          ...state.tasks,
          tasks,
          runningIds: isRunning
            ? [...state.tasks.runningIds, task.id]
            : state.tasks.runningIds,
          queuedIds: isQueued
            ? [...state.tasks.queuedIds, task.id]
            : state.tasks.queuedIds,
          totalCreated: state.tasks.totalCreated + 1,
          revision: state.tasks.revision + 1,
          lastUpdatedAt: Date.now(),
          source: 'process-adapter',
        },
      };
    });
  }

  private _transitionTask(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    extras: { exitCode?: number; error?: string },
  ): void {
    this._store.setState((state) => {
      const existing = state.tasks.tasks.get(taskId);
      if (!existing) return {};

      if (existing.status === status) return {};

      const now = Date.now();
      const updated: RuntimeTask = {
        ...existing,
        status,
        endedAt: now,
        exitCode: extras.exitCode,
        error: extras.error,
      };

      const tasks = new Map(state.tasks.tasks);
      tasks.set(taskId, updated);

      const runningIds = state.tasks.runningIds.filter((id) => id !== taskId);
      const queuedIds = state.tasks.queuedIds.filter((id) => id !== taskId);

      return {
        tasks: {
          ...state.tasks,
          tasks,
          runningIds,
          queuedIds,
          totalCompleted:
            status === 'completed'
              ? state.tasks.totalCompleted + 1
              : state.tasks.totalCompleted,
          totalFailed:
            status === 'failed'
              ? state.tasks.totalFailed + 1
              : state.tasks.totalFailed,
          totalCancelled:
            status === 'cancelled'
              ? state.tasks.totalCancelled + 1
              : state.tasks.totalCancelled,
          revision: state.tasks.revision + 1,
          lastUpdatedAt: now,
          source: 'process-adapter',
        },
      };
    });
  }
}
