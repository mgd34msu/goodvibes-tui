/**
 * TaskEvent — discriminated union covering all task lifecycle events.
 *
 * Maps to the typed runtime event contract for the  domain.
 */

export type TaskEvent =
  /** A new task has been created in the task queue. */
  | { type: 'TASK_CREATED'; taskId: string; agentId?: string; description: string; priority: number }
  /** Task execution has started. */
  | { type: 'TASK_STARTED'; taskId: string; agentId?: string }
  /** Task is blocked waiting on a dependency or resource. */
  | { type: 'TASK_BLOCKED'; taskId: string; agentId?: string; reason: string }
  /** Task has made measurable progress. */
  | { type: 'TASK_PROGRESS'; taskId: string; agentId?: string; progress: number; message?: string }
  /** Task completed successfully. */
  | { type: 'TASK_COMPLETED'; taskId: string; agentId?: string; durationMs: number }
  /** Task failed with an error. */
  | { type: 'TASK_FAILED'; taskId: string; agentId?: string; error: string; durationMs: number }
  /** Task was cancelled before completion. */
  | { type: 'TASK_CANCELLED'; taskId: string; agentId?: string; reason?: string };

/** All task event type literals as a union. */
export type TaskEventType = TaskEvent['type'];
