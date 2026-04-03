/**
 * src/runtime/compaction/index.ts
 *
 * Barrel re-export for the Session Compaction v2 lifecycle engine.
 *
 * Main entry point: `createCompactionManager()`
 *
 * Usage:
 * ```ts
 * import { createCompactionManager } from '../runtime/compaction/index.ts';
 *
 * const manager = createCompactionManager({ sessionId, bus, flags, contextWindow });
 * const result = await manager.compact({ messages, tokenCount, trigger: 'auto' });
 * ```
 */

import { CompactionManager } from './manager.ts';
import type { CompactionManagerOptions } from './manager.ts';

export { CompactionManager };
export type { CompactionManagerOptions };

export type {
  CompactionLifecycleState,
  CompactionStrategy,
  CompactionTrigger,
  StrategyInput,
  StrategyOutput,
  BoundaryCommit,
  CompactionLifecycleResult,
  RepairAction,
  RepairSeverity,
  ResumeRepairResult,
} from './types.ts';

export type { BoundaryCommitOptions } from './strategies/boundary-commit.ts';

export {
  canTransition,
  reachableFrom,
  applyTransition,
  isTerminal,
  isCompacting,
  selectStrategy,
  strategyToState,
} from './lifecycle.ts';

export type { TransitionResult, StrategySelectionParams } from './lifecycle.ts';

export { runResumeRepair } from './resume-repair.ts';
export type { ResumeRepairOptions } from './resume-repair.ts';

export {
  runMicrocompact,
  runCollapse,
  runAutocompact,
  runReactive,
  createBoundaryCommit,
  validateBoundaryCommit,
  computeQualityScore,
  describeScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from './strategies/index.ts';

export type {
  CompactionQualityScore,
  CompactionQualityGrade,
  SemanticRetentionSignals,
} from './strategies/index.ts';

/**
 * Factory function for creating a CompactionManager instance.
 *
 * Convenience wrapper over `new CompactionManager(opts)` for symmetry
 * with other runtime subsystem factories.
 *
 * NOTE: This factory is not yet wired to a consumer in the bootstrap layer.
 * Integration with the session bootstrap pipeline is the next step — the
 * CompactionManager will be instantiated per-session during session init
 * and attached to the session context for lifecycle event routing.
 *
 * @param opts - Manager options (see CompactionManagerOptions).
 * @returns A new CompactionManager instance.
 */
export function createCompactionManager(
  opts: CompactionManagerOptions,
): CompactionManager {
  return new CompactionManager(opts);
}
