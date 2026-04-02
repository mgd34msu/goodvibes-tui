/**
 * strategies/boundary-commit.ts
 *
 * Boundary commit — persists a compacted snapshot as a named checkpoint with
 * full lineage tracking for replay-safe session resumption.
 *
 * A boundary commit is always created after a successful compaction strategy
 * run (microcompact, collapse, autocompact, or reactive). It forms the
 * persistent anchor point that the resume-repair pipeline uses to restore
 * a session from a corrupted or partial state.
 *
 * Lineage is append-only: each commit appends its own checkpointId to the
 * parent's lineage array. This means any checkpoint can be sliced from any
 * earlier commit without re-ordering.
 */

import type { BoundaryCommit } from '../types.ts';
import type { StrategyOutput } from '../types.ts';

/** Simple prefix for generated checkpoint IDs. */
const CHECKPOINT_PREFIX = 'cpt';

/**
 * Generates a checkpoint ID using the current timestamp and a random suffix.
 * Format: `cpt_<timestamp>_<random>`
 */
function generateCheckpointId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${CHECKPOINT_PREFIX}_${ts}_${rand}`;
}

/**
 * Options for creating a boundary commit.
 */
export interface BoundaryCommitOptions {
  /** Session ID this commit belongs to. */
  sessionId: string;
  /** The compaction strategy output to commit. */
  strategyOutput: StrategyOutput;
  /** Parent boundary commit, or null for the first commit. */
  parent: BoundaryCommit | null;
  /** Estimated token count before compaction (for audit). */
  tokensBefore: number;
}

/**
 * Creates a new BoundaryCommit from a strategy output.
 *
 * The new commit's lineage is derived by appending its own checkpointId
 * to the parent's lineage (or starting a fresh lineage if `parent` is null).
 *
 * @param options - Commit options.
 * @returns A fully populated BoundaryCommit.
 */
export function createBoundaryCommit(
  options: BoundaryCommitOptions,
): BoundaryCommit {
  const { sessionId, strategyOutput, parent, tokensBefore } = options;
  const checkpointId = generateCheckpointId();

  const parentLineage: readonly string[] = parent?.lineage ?? [];
  const lineage: readonly string[] = [...parentLineage, checkpointId];

  return {
    checkpointId,
    sessionId,
    createdAt: Date.now(),
    strategy: strategyOutput.strategy,
    parentCheckpointId: parent?.checkpointId ?? null,
    lineage,
    messages: strategyOutput.messages,
    tokenCount: strategyOutput.tokensAfter,
    tokensBefore,
    summary: strategyOutput.summary,
  };
}

/**
 * Validates a BoundaryCommit for replay-safety.
 *
 * A commit is replay-safe if:
 * - It has at least one message
 * - Its lineage is ordered and contains its own checkpointId
 * - Its tokenCount is positive
 *
 * @returns An array of validation error strings (empty = valid).
 */
export function validateBoundaryCommit(commit: BoundaryCommit): string[] {
  const errors: string[] = [];

  if (commit.messages.length === 0) {
    errors.push('boundary_commit: no messages in checkpoint');
  }
  if (commit.tokenCount <= 0) {
    errors.push('boundary_commit: tokenCount must be positive');
  }
  if (!commit.lineage.includes(commit.checkpointId)) {
    errors.push('boundary_commit: checkpointId not found in lineage (lineage is corrupted)');
  }
  if (commit.lineage.length === 0) {
    errors.push('boundary_commit: lineage is empty');
  }

  return errors;
}
