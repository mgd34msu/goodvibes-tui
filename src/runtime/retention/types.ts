/**
 * types.ts
 *
 * Core types for the snapshot retention and pruning policy subsystem.
 *
 * Retention classes control how long checkpoints and compaction snapshots
 * are kept before pruning. Each class has independent age, count, and size
 * limits that are enforced by the pruning lifecycle.
 */

// ---------------------------------------------------------------------------
// Retention class
// ---------------------------------------------------------------------------

/**
 * Classification of a checkpoint's retention profile.
 *
 * - `short`    — ephemeral checkpoints; pruned aggressively (default for microcompact)
 * - `standard` — normal session checkpoints; 24 h window (default for autocompact/collapse)
 * - `forensic` — long-lived audit snapshots; 7-day window (crash reports, manual pins)
 */
export type RetentionClass = 'short' | 'standard' | 'forensic';

// ---------------------------------------------------------------------------
// Retention config
// ---------------------------------------------------------------------------

/**
 * Limits applied to a single retention class.
 *
 * Pruning removes checkpoints that violate ANY of the three limits.
 */
export interface RetentionClassConfig {
  /** Maximum age of a checkpoint in milliseconds. Older entries are pruned. */
  maxAgeMs: number;
  /** Maximum number of checkpoints to retain in this class. */
  maxCount: number;
  /** Maximum total size (bytes) of all retained checkpoints in this class. */
  maxSizeBytes: number;
}

/**
 * Full configuration for all three retention classes.
 *
 * Pass a partial override to `RetentionPolicy` to tune individual limits
 * without replacing all defaults.
 */
export interface RetentionConfig {
  /** Aggressive pruning for short-lived ephemeral checkpoints. */
  short: RetentionClassConfig;
  /** Standard 24-hour retention for normal session checkpoints. */
  standard: RetentionClassConfig;
  /** Long-lived forensic/audit checkpoints kept for 7 days. */
  forensic: RetentionClassConfig;
}

// ---------------------------------------------------------------------------
// Checkpoint record
// ---------------------------------------------------------------------------

/**
 * Metadata record for a single tracked checkpoint.
 *
 * This is the unit stored and evaluated by the retention policy. It wraps
 * the checkpoint identity (id, timestamps) with the file-system path needed
 * for safe deletion.
 */
export interface CheckpointRecord {
  /** Unique checkpoint identifier (e.g. `cpt_<ulid>`). */
  id: string;
  /** Unix timestamp (ms) when the checkpoint was created. */
  createdAt: number;
  /** Size of the checkpoint on disk in bytes. */
  sizeBytes: number;
  /** Retention class this checkpoint belongs to. */
  retentionClass: RetentionClass;
  /** Absolute file-system path for the checkpoint artifact. */
  path: string;
}

// ---------------------------------------------------------------------------
// Prune result
// ---------------------------------------------------------------------------

/**
 * Options for a `SnapshotPruner.delete()` invocation.
 */
export interface PruneOptions {
  /**
   * When `true`, the pruner returns what WOULD be deleted without performing
   * any file-system operations. Useful for previewing prune impact.
   */
  dryRun?: boolean;
}

/**
 * Outcome of a single `SnapshotPruner.prune()` invocation.
 */
export interface PruneResult {
  /** Number of checkpoints successfully deleted (0 when dryRun is true). */
  deletedCount: number;
  /** Total bytes reclaimed across all deleted checkpoints (0 when dryRun). */
  reclaimedBytes: number;
  /**
   * IDs of checkpoints that were actually deleted.
   * Empty when `dryRun` is true — see `candidateIds` instead.
   */
  deletedIds: readonly string[];
  /**
   * IDs of checkpoints that WOULD be deleted (dry-run mode only).
   * Always empty when `dryRun` is false.
   */
  candidateIds: readonly string[];
  /** IDs of checkpoints that failed to delete (path missing or I/O error). */
  failedIds: readonly string[];
  /** Errors keyed by checkpoint ID for failed deletions. */
  errors: Readonly<Record<string, string>>;
  /** Whether this result was produced in dry-run mode (no actual deletions). */
  dryRun: boolean;
  /** Per-class breakdown of deletion results. */
  byClass: Readonly<Record<RetentionClass, PerClassPruneResult>>;
}

/**
 * Per-retention-class breakdown within a `PruneResult`.
 */
export interface PerClassPruneResult {
  /** Number of checkpoints deleted in this class (0 in dry-run). */
  deletedCount: number;
  /** Bytes reclaimed in this class (0 in dry-run). */
  reclaimedBytes: number;
  /** IDs of checkpoints actually deleted in this class (empty in dry-run). */
  deletedIds: readonly string[];
  /** IDs of checkpoints that WOULD be deleted in this class (dry-run only). */
  candidateIds: readonly string[];
  /** IDs that failed to delete in this class. */
  failedIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Pruner interface
// ---------------------------------------------------------------------------

/**
 * Interface implemented by `SnapshotPruner` and test mocks alike.
 *
 * `RetentionPolicy` depends on this interface rather than the concrete class,
 * enabling full injection in tests without touching the file system.
 */
export interface Pruner {
  delete(candidates: readonly CheckpointRecord[], options?: PruneOptions): Promise<PruneResult>;
}

// ---------------------------------------------------------------------------
// Retention stats
// ---------------------------------------------------------------------------

/**
 * Per-class summary produced by `RetentionPolicy.getRetainedCount()`.
 */
export interface RetentionStats {
  /** Number of retained checkpoints per class. */
  counts: Record<RetentionClass, number>;
  /** Total size (bytes) of retained checkpoints per class. */
  sizes: Record<RetentionClass, number>;
  /** Total number of retained checkpoints across all classes. */
  totalCount: number;
  /** Total bytes across all retained checkpoints. */
  totalBytes: number;
}
