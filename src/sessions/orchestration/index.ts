/**
 * Multi-session orchestration — barrel exports.
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
export { CrossSessionTaskRegistry } from './registry.ts';
