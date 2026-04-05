/**
 * Tasks domain state — unified task lifecycle tracking across all
 * subsystem kinds: exec, agent, acp, scheduler, daemon, mcp, plugin, integration.
 */

/** States for the task lifecycle machine. */
export type TaskLifecycleState =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Task kind used by the runtime task domain. */
export type TaskKind =
  | 'exec'
  | 'agent'
  | 'acp'
  | 'scheduler'
  | 'daemon'
  | 'mcp'
  | 'plugin'
  | 'integration';

/** Retry policy for a task. */
export interface TaskRetryPolicy {
  /** Maximum number of retry attempts. */
  maxAttempts: number;
  /** Current attempt number (1-indexed). */
  currentAttempt: number;
  /** Delay in ms between retries (may be exponential). */
  delayMs: number;
  /** Backoff strategy. */
  backoff: 'fixed' | 'exponential';
  /** Error categories that trigger retry. */
  retryOn: Array<'network' | 'timeout' | 'transient' | 'tool_error'>;
}

/**
 * Full runtime task record. Every active or recently completed task
 * in the system has one of these in the tasks map.
 */
export interface RuntimeTask {
  /** Unique task ID (uuid). */
  id: string;
  /** Task kind stored on a runtime task record. */
  kind: TaskKind;
  /** Human-readable title for display in task monitor. */
  title: string;
  /** Optional detailed description. */
  description?: string;
  /** Current lifecycle state. */
  status: TaskLifecycleState;

  // ── Ownership ────────────────────────────────────────────────────────────
  /** Subsystem or agent ID that owns this task. */
  owner: string;
  /** Whether this task can be cancelled by the user. */
  cancellable: boolean;

  // ── Hierarchy ────────────────────────────────────────────────────────────
  /** Parent task ID if this is a subtask. */
  parentTaskId?: string;
  /** IDs of child tasks spawned by this task. */
  childTaskIds: string[];

  // ── Timing ───────────────────────────────────────────────────────────────
  /** Epoch ms when the task was queued. */
  queuedAt: number;
  /** Epoch ms when the task started running. */
  startedAt?: number;
  /** Epoch ms when the task completed, failed, or was cancelled. */
  endedAt?: number;

  // ── Retry ────────────────────────────────────────────────────────────────
  /** Retry policy (undefined = no retries). */
  retryPolicy?: TaskRetryPolicy;
  /**
   * Computed delay in ms before the next retry attempt.
   * Set by TaskManager.failTask() when re-queuing. The task runner is
   * responsible for not starting the task until `retryAt` has elapsed.
   */
  retryDelayMs?: number;
  /**
   * Epoch ms at which the task is eligible to run again after a retry re-queue.
   * Computed as `Date.now() + retryDelayMs` by TaskManager.failTask().
   * The task runner must not dequeue this task before this timestamp.
   */
  retryAt?: number;

  // ── Result ───────────────────────────────────────────────────────────────
  /** Exit code for exec tasks. */
  exitCode?: number;
  /** Error message if status === 'failed'. */
  error?: string;
  /** Optional structured result payload. */
  result?: unknown;

  // ── Correlation ──────────────────────────────────────────────────────────
  /** Correlation ID for distributed tracing. */
  correlationId?: string;
  /** Turn ID this task was spawned within. */
  turnId?: string;
}

/**
 * TaskDomainState — all runtime tasks across all subsystems.
 */
export interface TaskDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Task registry ──────────────────────────────────────────────────────────
  /** All known tasks keyed by task ID. */
  tasks: Map<string, RuntimeTask>;
  /** IDs of tasks in 'queued' state, ordered by queue time. */
  queuedIds: string[];
  /** IDs of tasks in 'running' state. */
  runningIds: string[];
  /** IDs of tasks in 'blocked' state. */
  blockedIds: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total tasks created this session. */
  totalCreated: number;
  /** Total tasks that completed successfully. */
  totalCompleted: number;
  /** Total tasks that failed. */
  totalFailed: number;
  /** Total tasks that were cancelled. */
  totalCancelled: number;

  // ── Concurrency ───────────────────────────────────────────────────────────
  /** Maximum concurrent running tasks allowed. */
  maxConcurrency: number;
}

/**
 * Returns the default initial state for the tasks domain.
 */
export function createInitialTasksState(): TaskDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    tasks: new Map(),
    queuedIds: [],
    runningIds: [],
    blockedIds: [],
    totalCreated: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalCancelled: 0,
    maxConcurrency: 8,
  };
}
