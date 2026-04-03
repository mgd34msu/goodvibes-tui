/**
 * strategies/index.ts
 *
 * Barrel re-export for all compaction strategy modules.
 */

export { runMicrocompact } from './microcompact.ts';
export { runCollapse } from './collapse.ts';
export { runAutocompact } from './autocompact.ts';
export { runReactive } from './reactive.ts';
export { createBoundaryCommit, validateBoundaryCommit } from './boundary-commit.ts';
export type { BoundaryCommitOptions } from './boundary-commit.ts';
export {
  computeQualityScore,
  describeScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from '../quality-score.ts';
export type {
  CompactionQualityScore,
  CompactionQualityGrade,
  SemanticRetentionSignals,
} from '../quality-score.ts';
