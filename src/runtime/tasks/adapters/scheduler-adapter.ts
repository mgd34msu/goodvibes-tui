/**
 * SchedulerTaskAdapter — bridges TaskScheduler scheduled job executions into
 * the unified RuntimeTask registry.
 *
 * Each time a scheduled task fires (i.e. TaskRunRecord is created), a
 * corresponding RuntimeTask of kind 'scheduler' is registered. The adapter
 * tracks runRecord agentId → task ID and handles completion via state sync.
 *
 * NOTE: This adapter writes directly to the Zustand store for performance,
 * bypassing TaskManager. Lifecycle validation is the caller's responsibility.
 * This is intentional — adapters are authoritative sources for their subsystem.
 */

import { randomUUID } from 'node:crypto';
import type { StoreApi } from 'zustand';
import type { RuntimeState } from '../../store/state.ts';
import type { RuntimeTask } from '../../store/domains/tasks.ts';
import type { TaskScheduler, ScheduledTask, TaskRunRecord } from '../../../scheduler/scheduler.ts';

/**
 * Bridges TaskScheduler job executions into the RuntimeTask registry.
 *
 * The scheduler runs jobs that spawn agent sessions. Each run is tracked as a
 * RuntimeTask of kind 'scheduler'. The run's agentId is used as the correlation
 * key between the scheduler's TaskRunRecord and the RuntimeTask.
 *
 * @example
 * ```ts
 * const adapter = new SchedulerTaskAdapter(store);
 * // When a scheduled task fires:
 * const taskId = adapter.wrapScheduledRun(record, scheduledTask);
 * // When the run completes:
 * adapter.handleRunComplete(record.agentId, 'completed');
 * ```
 */
export class SchedulerTaskAdapter {
  /** Maps run agentId → task ID. */
  private readonly _runToTask = new Map<string, string>();
  /** Maps task ID → run agentId. */
  private readonly _taskToRun = new Map<string, string>();

  constructor(private readonly _store: StoreApi<RuntimeState>) {}

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Wrap a scheduled task run as a RuntimeTask.
   *
   * @param record - The TaskRunRecord from the scheduler.
   * @param scheduledTask - The parent ScheduledTask definition.
   * @returns The new task ID.
   */
  wrapScheduledRun(record: TaskRunRecord, scheduledTask: ScheduledTask): string {
    // Idempotent: return existing if already wrapped
    const existing = this._runToTask.get(record.agentId);
    if (existing !== undefined) return existing;

    const taskId = randomUUID();
    const now = record.startedAt;

    const task: RuntimeTask = {
      id: taskId,
      kind: 'scheduler',
      title: `Scheduled: ${scheduledTask.name}`,
      description: scheduledTask.prompt.length > 200
        ? `${scheduledTask.prompt.slice(0, 197)}...`
        : scheduledTask.prompt,
      status: record.status === 'running' ? 'running' : 'completed',
      owner: `scheduler:${scheduledTask.id}`,
      cancellable: record.status === 'running',
      childTaskIds: [],
      queuedAt: now,
      startedAt: now,
      endedAt: record.status !== 'running' ? Date.now() : undefined,
      correlationId: record.agentId,
      turnId: record.taskId,
      error: record.error,
    };

    this._runToTask.set(record.agentId, taskId);
    this._taskToRun.set(taskId, record.agentId);

    this._upsertTask(task);
    return taskId;
  }

  /**
   * Handle a scheduled run completion or failure.
   *
   * @param runAgentId - The agentId from the TaskRunRecord.
   * @param status - Terminal status: 'completed' or 'failed'.
   * @param error - Optional error message if status is 'failed'.
   */
  handleRunComplete(
    runAgentId: string,
    status: 'completed' | 'failed',
    error?: string,
  ): void {
    const taskId = this._runToTask.get(runAgentId);
    if (taskId === undefined) return;

    this._transitionTask(taskId, status, { error });
    this._runToTask.delete(runAgentId);
    this._taskToRun.delete(taskId);
  }

  /**
   * Cancel a scheduled run task by task ID.
   * Marks the task as cancelled. The caller is responsible for disabling the
   * scheduled task via TaskScheduler.setEnabled().
   *
   * @param taskId - The RuntimeTask ID to cancel.
   */
  cancelScheduled(taskId: string): void {
    const runAgentId = this._taskToRun.get(taskId);
    if (runAgentId === undefined) return;

    this._transitionTask(taskId, 'cancelled', {});
    this._runToTask.delete(runAgentId);
    this._taskToRun.delete(taskId);
  }

  /**
   * Reconcile adapter state with the current TaskScheduler snapshot.
   *
   * Scans all run history records from the scheduler:
   * - Wraps any un-tracked running jobs as new tasks.
   * - Marks completed/failed jobs that are still showing as running.
   *
   * @param scheduler - The TaskScheduler instance to sync from.
   */
  sync(scheduler: TaskScheduler): void {
    const scheduledTasks = scheduler.list();
    const scheduledTaskMap = new Map<string, ScheduledTask>(
      scheduledTasks.map((t) => [t.id, t]),
    );

    const allHistory = scheduler.getAllHistory();
    const runningRuns = allHistory.filter((r) => r.status === 'running');

    for (const record of runningRuns) {
      const scheduledTask = scheduledTaskMap.get(record.taskId);
      if (!scheduledTask) continue;

      if (!this._runToTask.has(record.agentId)) {
        this.wrapScheduledRun(record, scheduledTask);
      }
    }

    // Reconcile tracked runs that are no longer running.
    // Build a Map for O(1) history lookups — acceptable O(n) build at current scheduler scale.
    const historyByAgentId = new Map<string, TaskRunRecord>(allHistory.map((r) => [r.agentId, r]));
    const runningAgentIds = new Set(runningRuns.map((r) => r.agentId));
    const staleRunIds: string[] = [];
    for (const [runAgentId] of this._runToTask.entries()) {
      if (!runningAgentIds.has(runAgentId)) staleRunIds.push(runAgentId);
    }
    for (const runAgentId of staleRunIds) {
      const taskId = this._runToTask.get(runAgentId)!;
      const record = historyByAgentId.get(runAgentId);
      const terminalStatus = record?.status === 'failed' ? 'failed' : 'completed';
      this._transitionTask(taskId, terminalStatus, { error: record?.error });
      this._runToTask.delete(runAgentId);
      this._taskToRun.delete(taskId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _upsertTask(task: RuntimeTask): void {
    this._store.setState((state) => {
      const tasks = new Map(state.tasks.tasks);
      tasks.set(task.id, task);

      const isRunning = task.status === 'running';

      return {
        tasks: {
          ...state.tasks,
          tasks,
          runningIds: isRunning
            ? [...state.tasks.runningIds, task.id]
            : state.tasks.runningIds,
          totalCreated: state.tasks.totalCreated + 1,
          totalCompleted:
            !isRunning && task.status === 'completed'
              ? state.tasks.totalCompleted + 1
              : state.tasks.totalCompleted,
          totalFailed:
            !isRunning && task.status === 'failed'
              ? state.tasks.totalFailed + 1
              : state.tasks.totalFailed,
          revision: state.tasks.revision + 1,
          lastUpdatedAt: Date.now(),
          source: 'scheduler-adapter',
        },
      };
    });
  }

  private _transitionTask(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    opts: { error?: string },
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
        error: opts.error,
      };

      const tasks = new Map(state.tasks.tasks);
      tasks.set(taskId, updated);

      return {
        tasks: {
          ...state.tasks,
          tasks,
          runningIds: state.tasks.runningIds.filter((id) => id !== taskId),
          queuedIds: state.tasks.queuedIds.filter((id) => id !== taskId),
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
          source: 'scheduler-adapter',
        },
      };
    });
  }
}
