/**
 * Task manager types — public interfaces for creating, updating, and
 * managing RuntimeTask lifecycle through the UnifiedTaskManager.
 */
import type { TaskKind, TaskLifecycleState, TaskRetryPolicy, RuntimeTask } from '../store/domains/tasks.ts';

// ---------------------------------------------------------------------------
// Task creation params
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by `TaskManager.createTask()` to create a new task.
 *
 * Required fields: `kind`, `title`, `owner`.
 * All other fields are optional and have sensible defaults.
 */
export interface TaskCreateParams {
  /** Task kind from the runtime task taxonomy. */
  kind: TaskKind;
  /** Human-readable title for display in the task monitor. */
  title: string;
  /** Subsystem or agent ID that owns this task. */
  owner: string;
  /** Optional detailed description. */
  description?: string;
  /** Parent task ID if this is a subtask. */
  parentTaskId?: string;
  /** Whether this task can be cancelled by the user. Defaults to `true`. */
  cancellable?: boolean;
  /** Retry policy (undefined = no retries). */
  retryPolicy?: TaskRetryPolicy;
  /** Correlation ID for distributed tracing. */
  correlationId?: string;
  /** Turn ID this task was spawned within. */
  turnId?: string;
}

// ---------------------------------------------------------------------------
// Task update params
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by `TaskManager.updateTask()` to patch mutable
 * fields on an existing task without triggering a lifecycle transition.
 *
 * Status transitions MUST go through the dedicated transition methods
 * (`startTask`, `completeTask`, `failTask`, etc.) to enforce invariants.
 */
export interface TaskUpdateParams {
  /** Updated human-readable title. */
  title?: string;
  /** Updated description. */
  description?: string;
  /** Updated exit code (exec tasks). */
  exitCode?: number;
  /** Updated result payload. */
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Cancellation params
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by `TaskManager.cancelTask()`.
 */
export interface TaskCancelParams {
  /** Human-readable reason for cancellation. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Failure params
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by `TaskManager.failTask()`.
 */
export interface TaskFailParams {
  /** Error message describing the failure. */
  error: string;
  /** Exit code if applicable (exec tasks). */
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// TaskManager interface
// ---------------------------------------------------------------------------

/**
 * TaskManager — the public interface for the unified task management system.
 *
 * All task lifecycle transitions and mutations go through this interface.
 * Implementations MUST:
 * - Enforce lifecycle invariants (reject invalid transitions)
 * - Emit TaskEvents via RuntimeEventBus at each transition
 * - Update RuntimeState.tasks domain via store dispatch
 * - Track parent/child relationships
 * - Support retry policies (re-queue on failure when policy allows)
 */
export interface TaskManager {
  /**
   * Creates a new task in the 'queued' state and registers it in the store.
   *
   * @param params - Task creation parameters.
   * @returns The created RuntimeTask.
   */
  createTask(params: TaskCreateParams): RuntimeTask;

  /**
   * Transitions a task from 'queued' to 'running'.
   *
   * @param taskId - The task to start.
   * @returns The updated RuntimeTask.
   * @throws If the task does not exist or cannot transition to 'running'.
   */
  startTask(taskId: string): RuntimeTask;

  /**
   * Transitions a task to 'blocked' (waiting on a dependency or resource).
   *
   * @param taskId - The task to block.
   * @param reason - Human-readable reason for the block.
   * @returns The updated RuntimeTask.
   * @throws If the task does not exist or cannot transition to 'blocked'.
   */
  blockTask(taskId: string, reason: string): RuntimeTask;

  /**
   * Transitions a task to 'completed'.
   *
   * @param taskId - The task to complete.
   * @param result - Optional result payload.
   * @returns The updated RuntimeTask.
   * @throws If the task does not exist or cannot transition to 'completed'.
   */
  completeTask(taskId: string, result?: unknown): RuntimeTask;

  /**
   * Transitions a task to 'failed'. If the task has a retry policy with
   * remaining attempts, re-queues the task instead.
   *
   * @param taskId - The task that failed.
   * @param params - Failure details.
   * @returns The updated RuntimeTask (may be back in 'queued' if retried).
   * @throws If the task does not exist or cannot transition to 'failed'.
   */
  failTask(taskId: string, params: TaskFailParams): RuntimeTask;

  /**
   * Transitions a task to 'cancelled'.
   *
   * @param taskId - The task to cancel.
   * @param params - Optional cancellation context.
   * @returns The updated RuntimeTask.
   * @throws If the task does not exist, is not cancellable, or cannot
   *   transition to 'cancelled'.
   */
  cancelTask(taskId: string, params?: TaskCancelParams): RuntimeTask;

  /**
   * Applies a partial update to mutable fields of an existing task.
   * Does NOT trigger a lifecycle transition or emit a transition event.
   *
   * @param taskId - The task to update.
   * @param params - Fields to update.
   * @returns The updated RuntimeTask.
   * @throws If the task does not exist.
   */
  updateTask(taskId: string, params: TaskUpdateParams): RuntimeTask;

  /**
   * Retrieves a task by ID from the registry.
   *
   * @param taskId - The task ID to look up.
   * @returns The RuntimeTask if found, or `undefined`.
   */
  getTask(taskId: string): RuntimeTask | undefined;

  /**
   * Returns all tasks of a given kind.
   *
   * @param kind - The TaskKind to filter by.
   */
  getTasksByKind(kind: TaskKind): RuntimeTask[];

  /**
   * Returns all currently running tasks.
   */
  getRunningTasks(): RuntimeTask[];

  /**
   * Returns the count of running tasks for a given kind.
   * Used for per-kind concurrency tracking.
   *
   * @param kind - The TaskKind to count.
   */
  getRunningCount(kind: TaskKind): number;

  /**
   * Returns all child tasks of a given parent task.
   *
   * @param parentTaskId - The parent task ID.
   */
  getChildTasks(parentTaskId: string): RuntimeTask[];

  /**
   * Returns the current TaskLifecycleState of a task.
   *
   * @param taskId - The task ID to query.
   * @returns The current status, or `undefined` if the task does not exist.
   */
  getTaskStatus(taskId: string): TaskLifecycleState | undefined;

  /**
   * Re-queues a failed or cancelled task for execution.
   *
   * Transitions the task back to 'queued', clearing terminal-state fields
   * (error, exitCode, endedAt, startedAt). Only valid from 'failed' or
   * 'cancelled' states.
   *
   * @param taskId - The task to retry.
   * @returns The updated RuntimeTask in 'queued' state.
   * @throws If the task does not exist or is not in a retryable state.
   */
  retryTask(taskId: string): RuntimeTask;
}
