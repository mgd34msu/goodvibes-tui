/**
 * Multi-session Orchestration — Core Types
 *
 * Implements Section 5.12: global task references across sessions,
 * status/dependency propagation, and scoped cancellation semantics.
 */

import type { TaskLifecycleState } from '../../runtime/store/domains/tasks.ts';

// ── Cross-session task reference ─────────────────────────────────────────────

/**
 * A globally addressable reference to a task that may live in any session.
 *
 * The combination of sessionId + taskId is universally unique within a
 * goodvibes-tui process. Refs survive session reconnect/resume because
 * sessionId is stable (matches the durable identity in the remote substrate).
 */
export interface CrossSessionTaskRef {
  /** Stable session ID that owns this task (matches DurableIdentity.sessionId). */
  readonly sessionId: string;
  /** Task ID within that session. */
  readonly taskId: string;
  /** Human-readable title for display in the graph view. */
  readonly title: string;
  /** Current lifecycle status — propagated on update. */
  status: TaskLifecycleState;
  /** Epoch ms when this ref was created. */
  readonly createdAt: number;
  /** Epoch ms of last status update. */
  updatedAt: number;
  /** Optional label applied at link time. */
  label?: string;
}

// ── Dependency edge ───────────────────────────────────────────────────────────

/**
 * A directed dependency edge between two cross-session task refs.
 *
 * Semantics: `from` depends on `to` (i.e., `from` should not start until
 * `to` is completed or cancelled).
 */
export interface TaskDependencyEdge {
  /** The task that depends on another. */
  readonly fromRef: Pick<CrossSessionTaskRef, 'sessionId' | 'taskId'>;
  /** The task being depended upon. */
  readonly toRef: Pick<CrossSessionTaskRef, 'sessionId' | 'taskId'>;
  /** Epoch ms when the dependency was established. */
  readonly linkedAt: number;
  /** Optional human-readable reason for the dependency. */
  readonly reason?: string;
}

// ── Handoff record ────────────────────────────────────────────────────────────

/**
 * Records a task handoff — when a task's continuation is transferred from
 * one session to another. Handoffs preserve causal context across reconnects.
 */
export interface TaskHandoffRecord {
  /** Unique handoff ID. */
  readonly handoffId: string;
  /** The task being handed off. */
  readonly taskRef: Pick<CrossSessionTaskRef, 'sessionId' | 'taskId'>;
  /** Session ID handing off the task (source). */
  readonly fromSessionId: string;
  /** Session ID receiving the task (destination). */
  readonly toSessionId: string;
  /** Human-readable reason for the handoff. */
  readonly reason?: string;
  /** Epoch ms when the handoff was initiated. */
  readonly initiatedAt: number;
  /** Whether the handoff completed (destination session acknowledged it). */
  acknowledged: boolean;
  /** Epoch ms when the destination acknowledged. */
  acknowledgedAt?: number;
}

// ── Cancellation scope ────────────────────────────────────────────────────────

/**
 * Defines the scope of a cross-session cancellation operation.
 *
 * - `task`   — Cancel only the specific task.
 * - `subtree` — Cancel the task and all transitive dependents (tasks that
 *               depend on this one directly or indirectly).
 * - `session` — Cancel all tasks owned by the given session.
 */
export type CancellationScope = 'task' | 'subtree' | 'session';

/**
 * The set of valid cancellation scope values — exported for use in command
 * handlers to avoid duplication.
 */
export const VALID_SCOPES: ReadonlyArray<CancellationScope> = ['task', 'subtree', 'session'] as const;

/**
 * Parameters for a scoped cancellation request.
 */
export interface CancellationRequest {
  /** Session ID of the task to cancel (required for task/subtree scope). */
  sessionId: string;
  /** Task ID to cancel (required for task/subtree scope; ignored for session scope). */
  taskId?: string;
  /** Cancellation scope — defaults to 'task'. */
  scope: CancellationScope;
  /** Human-readable reason surfaced to the task owner. */
  reason?: string;
  /** Epoch ms when the cancellation was requested. */
  readonly requestedAt: number;
}

/**
 * Result of a scoped cancellation operation.
 */
export interface CancellationResult {
  /** Whether the cancellation was fully applied. */
  ok: boolean;
  /** Task refs that were cancelled as part of this operation. */
  cancelled: Array<Pick<CrossSessionTaskRef, 'sessionId' | 'taskId' | 'title'>>;
  /** Task refs that could not be cancelled (e.g. already terminal). */
  skipped: Array<Pick<CrossSessionTaskRef, 'sessionId' | 'taskId' | 'title'> & { reason: string }>;
  /** Error message if the operation failed entirely. */
  error?: string;
}

// ── Graph snapshot ────────────────────────────────────────────────────────────

/**
 * A point-in-time snapshot of the full cross-session task graph.
 *
 * Used for persistence, reconnect hydration, and the `/session graph` display.
 */
export interface SessionTaskGraphSnapshot {
  /** Schema version — increment on breaking changes. */
  readonly version: 1;
  /** Epoch ms when this snapshot was taken. */
  readonly snapshotAt: number;
  /** All tracked cross-session task refs, keyed by `${sessionId}:${taskId}`. */
  readonly refs: Record<string, CrossSessionTaskRef>;
  /** All dependency edges. */
  readonly edges: TaskDependencyEdge[];
  /** All handoff records. */
  readonly handoffs: TaskHandoffRecord[];
}

// ── Graph key helper ──────────────────────────────────────────────────────────

/**
 * Build a stable composite key for a cross-session task ref.
 *
 * @param sessionId - The owning session ID.
 * @param taskId - The task ID within that session.
 * @returns A colon-delimited composite key suitable for Map/Record keying.
 */
export function makeRefKey(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}
