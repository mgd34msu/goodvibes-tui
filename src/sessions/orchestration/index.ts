/**
 * Multi-session Orchestration — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { getSessionOrchestration } from './orchestration/index.ts';
 *
 * const orchestration = getSessionOrchestration();
 * orchestration.linkTask({ sessionId, taskId, title, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() });
 * ```
 */

export type {
  CrossSessionTaskRef,
  TaskDependencyEdge,
  TaskHandoffRecord,
  CancellationScope,
  CancellationRequest,
  CancellationResult,
  SessionTaskGraphSnapshot,
} from './types.ts';

export { makeRefKey, VALID_SCOPES } from './types.ts';
export { SessionTaskGraph } from './graph.ts';
export { CrossSessionTaskRegistry, getSessionOrchestration, _resetForTesting } from './registry.ts';
