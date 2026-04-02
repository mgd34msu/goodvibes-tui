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
