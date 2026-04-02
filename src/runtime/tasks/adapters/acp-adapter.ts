/**
 * AcpTaskAdapter — bridges ACP remote subagent tasks (managed by AcpManager)
 * into the unified RuntimeTask registry.
 *
 * Each spawned ACP subagent gets a corresponding RuntimeTask of kind 'acp'.
 * The adapter maps SubagentStatus strings to task lifecycle transitions.
 */

import { randomUUID } from 'node:crypto';
import type { StoreApi } from 'zustand';
import type { RuntimeState } from '../../store/state.ts';
import type { RuntimeTask } from '../../store/domains/tasks.ts';
import type { SubagentStatus } from '../../../acp/protocol.ts';
import type { AcpManager } from '../../../acp/manager.ts';

/**
 * Maps an ACP SubagentStatus to a RuntimeTask lifecycle state.
 *
 * @param status - SubagentStatus from the ACP protocol.
 * @returns Corresponding task lifecycle state.
 */
function mapAcpStatusToTask(
  status: SubagentStatus,
): 'running' | 'completed' | 'failed' | 'cancelled' {
  switch (status) {
    case 'running':
      return 'running';
    case 'complete':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Terminal ACP statuses. */
const TERMINAL_ACP_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  'complete',
  'error',
  'cancelled',
]);

/**
 * Bridges ACP remote subagent tasks into the RuntimeTask registry.
 *
 * NOTE: This adapter writes directly to the Zustand store for performance,
 * bypassing TaskManager. Lifecycle validation is the caller's responsibility.
 * This is intentional — adapters are authoritative sources for their subsystem.
 *
 * @example
 * ```ts
 * const adapter = new AcpTaskAdapter(store);
 * const taskId = adapter.wrapRemoteTask(acpId, 'Refactor auth module');
 * adapter.handleRemoteUpdate(acpId, 'complete');
 * ```
 */
export class AcpTaskAdapter {
  /** Maps ACP remote ID → task ID. */
  private readonly _remoteToTask = new Map<string, string>();
  /** Maps task ID → ACP remote ID. */
  private readonly _taskToRemote = new Map<string, string>();

  constructor(private readonly _store: StoreApi<RuntimeState>) {}

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Wrap an ACP remote subagent task as a RuntimeTask.
   *
   * @param remoteId - The ACP subagent ID from AcpManager.spawn().
   * @param title - Human-readable title for display in the task monitor.
   * @returns The new task ID.
   */
  wrapRemoteTask(remoteId: string, title: string): string {
    // Idempotent: return existing task ID if already wrapped
    const existing = this._remoteToTask.get(remoteId);
    if (existing !== undefined) return existing;

    const taskId = randomUUID();
    const now = Date.now();

    const task: RuntimeTask = {
      id: taskId,
      kind: 'acp',
      title: title.length > 80 ? `${title.slice(0, 77)}...` : title,
      description: title,
      status: 'running',
      owner: remoteId,
      cancellable: true,
      childTaskIds: [],
      queuedAt: now,
      startedAt: now,
      correlationId: remoteId,
    };

    this._remoteToTask.set(remoteId, taskId);
    this._taskToRemote.set(taskId, remoteId);

    this._upsertTask(task);
    return taskId;
  }

  /**
   * Handle an ACP status update and transition the task accordingly.
   *
   * @param remoteId - The ACP subagent ID.
   * @param status - New status string (SubagentStatus).
   */
  handleRemoteUpdate(remoteId: string, status: SubagentStatus): void {
    const taskId = this._remoteToTask.get(remoteId);
    if (taskId === undefined) return;

    const acpStatus = status;
    const taskStatus = mapAcpStatusToTask(acpStatus);
    const isTerminal = TERMINAL_ACP_STATUSES.has(acpStatus);

    this._transitionTask(taskId, taskStatus, {
      isTerminal,
      error: acpStatus === 'error' ? `ACP subagent ${remoteId} reported an error` : undefined,
    });

    if (isTerminal) {
      this._remoteToTask.delete(remoteId);
      this._taskToRemote.delete(taskId);
    }
  }

  /**
   * Cancel an ACP remote task by task ID.
   * Cancels the underlying ACP connection via AcpManager and marks the task cancelled.
   *
   * @param taskId - The RuntimeTask ID to cancel.
   * @param manager - The AcpManager instance to use for cancellation.
   */
  cancelRemote(taskId: string, manager?: AcpManager): void {
    const remoteId = this._taskToRemote.get(taskId);
    if (remoteId === undefined) return;

    if (manager) {
      // Fire-and-forget cancellation; errors are non-fatal
      void manager.cancel(remoteId).catch(() => {
        // Non-fatal: process may have already exited
      });
    }

    this._transitionTask(taskId, 'cancelled', { isTerminal: true });
    this._remoteToTask.delete(remoteId);
    this._taskToRemote.delete(taskId);
  }

  /**
   * Reconcile adapter state with the current AcpManager snapshot.
   *
   * @param manager - The AcpManager whose active subagents to sync from.
   */
  sync(manager: AcpManager): void {
    const active = manager.getActive();
    const liveIds = new Set(active.map((a) => a.id));

    // Wrap newly discovered subagents
    for (const subagent of active) {
      if (!this._remoteToTask.has(subagent.id)) {
        this.wrapRemoteTask(subagent.id, subagent.task);
      }

      // Sync status if non-running
      if (subagent.status !== 'running') {
        this.handleRemoteUpdate(subagent.id, subagent.status);
      }
    }

    // Mark stale tracked subagents as cancelled
    const staleRemoteIds: string[] = [];
    for (const [remoteId] of this._remoteToTask.entries()) {
      if (!liveIds.has(remoteId)) staleRemoteIds.push(remoteId);
    }
    for (const remoteId of staleRemoteIds) {
      const taskId = this._remoteToTask.get(remoteId)!;
      this._transitionTask(taskId, 'cancelled', { isTerminal: true });
      this._remoteToTask.delete(remoteId);
      this._taskToRemote.delete(taskId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _upsertTask(task: RuntimeTask): void {
    this._store.setState((state) => {
      const tasks = new Map(state.tasks.tasks);
      tasks.set(task.id, task);

      return {
        tasks: {
          ...state.tasks,
          tasks,
          runningIds: task.status === 'running'
            ? [...state.tasks.runningIds, task.id]
            : state.tasks.runningIds,
          totalCreated: state.tasks.totalCreated + 1,
          revision: state.tasks.revision + 1,
          lastUpdatedAt: Date.now(),
          source: 'acp-adapter',
        },
      };
    });
  }

  private _transitionTask(
    taskId: string,
    status: 'running' | 'completed' | 'failed' | 'cancelled',
    opts: { isTerminal?: boolean; error?: string },
  ): void {
    this._store.setState((state) => {
      const existing = state.tasks.tasks.get(taskId);
      if (!existing) return {};

      // No-op if already in the same terminal status
      if (existing.status === status) return {};

      const now = Date.now();
      const updated: RuntimeTask = {
        ...existing,
        status,
        endedAt: opts.isTerminal ? now : existing.endedAt,
        error: opts.error,
      };

      const tasks = new Map(state.tasks.tasks);
      tasks.set(taskId, updated);

      const runningIds = status === 'running'
        ? [...state.tasks.runningIds.filter((id) => id !== taskId), taskId]
        : state.tasks.runningIds.filter((id) => id !== taskId);

      return {
        tasks: {
          ...state.tasks,
          tasks,
          runningIds,
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
          source: 'acp-adapter',
        },
      };
    });
  }
}
