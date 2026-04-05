/**
 * Task lifecycle state machine — pure transition logic with no side effects.
 *
 * Implements the task lifecycle state machine:
 *
 * ```
 * queued → running
 * running → blocked | completed | failed | cancelled | queued (retry re-queue)
 * blocked → running | cancelled | failed
 * completed → (terminal)
 * failed → (terminal)
 * cancelled → (terminal)
 * ```
 */
import type { TaskLifecycleState } from '../store/domains/tasks.ts';

/**
 * Adjacency list for valid task state transitions.
 * Terminal states map to empty arrays — no outbound transitions.
 */
const VALID_TRANSITIONS: Record<TaskLifecycleState, TaskLifecycleState[]> = {
  queued: ['running', 'cancelled'],
  running: ['blocked', 'completed', 'failed', 'cancelled', 'queued'], // queued = retry re-queue
  blocked: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Returns true if a transition from `from` to `to` is permitted by the
 * task lifecycle state machine.
 *
 * @param from - Current task status.
 * @param to - Desired target status.
 * @returns `true` if the transition is valid; `false` otherwise.
 *
 * @example
 * ```ts
 * canTransition('queued', 'running');    // true
 * canTransition('completed', 'running'); // false
 * canTransition('running', 'blocked');   // true
 * ```
 */
export function canTransition(
  from: TaskLifecycleState,
  to: TaskLifecycleState
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Returns the set of states reachable from `from` in one transition.
 *
 * @param from - Current task status.
 * @returns Array of valid target statuses (may be empty for terminal states).
 *
 * @example
 * ```ts
 * getValidTransitions('running');
 * // => ['blocked', 'completed', 'failed', 'cancelled']
 *
 * getValidTransitions('completed');
 * // => []
 * ```
 */
export function getValidTransitions(
  from: TaskLifecycleState
): TaskLifecycleState[] {
  return [...VALID_TRANSITIONS[from]];
}

/**
 * Returns true if `status` is a terminal lifecycle state (no further
 * transitions are possible).
 *
 * @param status - The task status to check.
 */
export function isTerminalStatus(status: TaskLifecycleState): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}
