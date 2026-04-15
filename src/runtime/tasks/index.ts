/**
 * Runtime Tasks — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createTaskManager } from './tasks/index.ts';
 *
 * const taskManager = createTaskManager(store, bus, sessionId);
 * const task = taskManager.createTask({ kind: 'exec', title: 'Run lint', owner: 'exec-tool' });
 * taskManager.startTask(task.id);
 * taskManager.completeTask(task.id);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  TaskManager,
  TaskCreateParams,
  TaskUpdateParams,
  TaskCancelParams,
  TaskFailParams,
} from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export {
  canTransition,
  getValidTransitions,
  isTerminalStatus,
} from '@pellux/goodvibes-sdk/platform/runtime/tasks/lifecycle';

// ── Registry ──────────────────────────────────────────────────────────────────
export { TaskRegistry } from '@pellux/goodvibes-sdk/platform/runtime/tasks/registry';

// ── Manager ───────────────────────────────────────────────────────────────────
export {
  UnifiedTaskManager,
  TaskTransitionError,
  TaskNotFoundError,
  TaskNotCancellableError,
} from './manager.ts';

// ── Factory ───────────────────────────────────────────────────────────────────
import type { RuntimeStore } from '../store/index.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { TaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';
import { UnifiedTaskManager } from './manager.ts';

/**
 * Creates a fully initialized UnifiedTaskManager bound to the given
 * Zustand store, RuntimeEventBus, and session identifier.
 *
 * @param store - The runtime Zustand store.
 * @param bus - The RuntimeEventBus for event emission.
 * @param sessionId - Current session identifier (used in emitter context).
 * @returns A TaskManager instance ready for use.
 *
 * @example
 * ```ts
 * const taskManager = createTaskManager(store, bus, sessionId);
 * ```
 */
export function createTaskManager(
  store: RuntimeStore,
  bus: RuntimeEventBus,
  sessionId: string
): TaskManager {
  return new UnifiedTaskManager(store, bus, sessionId);
}
