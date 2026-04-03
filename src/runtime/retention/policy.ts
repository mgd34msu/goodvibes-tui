/**
 * policy.ts
 *
 * `RetentionPolicy` — tracks registered checkpoints and decides which ones
 * must be pruned to satisfy the configured retention limits.
 *
 * Each retention class (`short`, `standard`, `forensic`) has independent
 * age, count, and size ceilings. Pruning candidates are determined in the
 * following order:
 *
 *  1. Age limit  — any record older than `maxAgeMs` is a candidate.
 *  2. Count limit — oldest records beyond `maxCount` are candidates.
 *  3. Size limit  — oldest records are candidates until total size fits.
 *
 * The actual file deletion is delegated to `SnapshotPruner`.
 */

import type {
  CheckpointRecord,
  Pruner,
  PruneOptions,
  PruneResult,
  RetentionClass,
  RetentionClassConfig,
  RetentionConfig,
  RetentionStats,
} from './types.ts';
import { SnapshotPruner } from './pruner.ts';

// ---------------------------------------------------------------------------
// Default retention configuration
// ---------------------------------------------------------------------------

/**
 * Default limits applied when no override is provided.
 *
 * - `short`    : 1 h  / 5 checkpoints  / 50 MB
 * - `standard` : 24 h / 20 checkpoints / 200 MB
 * - `forensic` : 7 d  / 100 checkpoints / 1 GB
 */
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  short: {
    maxAgeMs: 60 * 60 * 1000, // 1 hour
    maxCount: 5,
    maxSizeBytes: 50 * 1024 * 1024, // 50 MB
  },
  standard: {
    maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    maxCount: 20,
    maxSizeBytes: 200 * 1024 * 1024, // 200 MB
  },
  forensic: {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    maxCount: 100,
    maxSizeBytes: 1024 * 1024 * 1024, // 1 GB
  },
};

// ---------------------------------------------------------------------------
// RetentionPolicy
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of checkpoint records by enforcing per-class
 * retention limits (age, count, size).
 *
 * @example
 * ```ts
 * const policy = new RetentionPolicy();
 * policy.register({
 *   id: 'cpt_01',
 *   createdAt: Date.now(),
 *   sizeBytes: 1024,
 *   retentionClass: 'standard',
 *   path: '/tmp/checkpoints/cpt_01.json',
 * });
 * const result = await policy.prune();
 * ```
 */
export class RetentionPolicy {
  private readonly _config: RetentionConfig;
  private readonly _records: Map<string, CheckpointRecord>;
  private readonly _pruner: Pruner;
  private readonly _clock: () => number;

  /**
   * @param config - Optional partial override for any retention class limits.
   *                 Unspecified classes fall back to `DEFAULT_RETENTION_CONFIG`.
   * @param clock  - Optional clock function returning the current time in ms.
   *                 Defaults to `Date.now`. Inject a fixed value in tests for
   *                 deterministic time-based assertions.
   * @param pruner - Optional pruner implementation. Defaults to `new SnapshotPruner()`.
   *                 Inject a mock in tests to avoid file-system I/O.
   */
  constructor(
    config?: Partial<RetentionConfig>,
    clock: () => number = Date.now,
    pruner?: Pruner,
  ) {
    const merged = {
      short: { ...DEFAULT_RETENTION_CONFIG.short, ...config?.short },
      standard: { ...DEFAULT_RETENTION_CONFIG.standard, ...config?.standard },
      forensic: { ...DEFAULT_RETENTION_CONFIG.forensic, ...config?.forensic },
    };

    // Validate merged config values.
    for (const cls of ['short', 'standard', 'forensic'] as const) {
      const c = merged[cls];
      if (c.maxAgeMs < 0) {
        throw new RangeError(`RetentionPolicy: ${cls}.maxAgeMs must be >= 0, got ${c.maxAgeMs}`);
      }
      if (c.maxCount <= 0) {
        throw new RangeError(`RetentionPolicy: ${cls}.maxCount must be > 0, got ${c.maxCount}`);
      }
      if (c.maxSizeBytes < 0) {
        throw new RangeError(`RetentionPolicy: ${cls}.maxSizeBytes must be >= 0, got ${c.maxSizeBytes}`);
      }
    }

    this._config = merged;
    this._records = new Map();
    this._pruner = pruner ?? new SnapshotPruner();
    this._clock = clock;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a new checkpoint for retention tracking.
   *
   * If a record with the same `id` already exists it is silently replaced,
   * allowing callers to update metadata (e.g. size after write).
   *
   * @param record - The checkpoint record to track.
   */
  register(record: CheckpointRecord): void {
    this._records.set(record.id, record);
  }

  /**
   * Unregister a checkpoint record (e.g. after it has been pruned externally).
   *
   * @param id - The checkpoint ID to remove from tracking.
   * @returns `true` if the record was found and removed, `false` otherwise.
   */
  unregister(id: string): boolean {
    return this._records.delete(id);
  }

  /**
   * Prune checkpoints that exceed retention limits.
   *
   * Evaluates each retention class independently and delegates file removal
   * to `SnapshotPruner`. Successfully deleted records are removed from the
   * internal tracking map.
   *
   * @param options - Optional prune options (e.g. `dryRun: true` to preview
   *                  what would be deleted without touching the file system).
   * @returns Aggregated `PruneResult` across all classes.
   */
  async prune(options?: PruneOptions): Promise<PruneResult> {
    const candidates = this._collectCandidates();
    const result = await this._pruner.delete(candidates, options);

    // Remove successfully deleted records from tracking (skip on dry run).
    if (!result.dryRun) {
      for (const id of result.deletedIds) {
        this._records.delete(id);
      }
    }

    return result;
  }

  /**
   * Return current retention statistics per class.
   *
   * Useful for surfacing storage pressure in diagnostics panels.
   */
  getRetainedCount(): RetentionStats {
    const counts: Record<RetentionClass, number> = {
      short: 0,
      standard: 0,
      forensic: 0,
    };
    const sizes: Record<RetentionClass, number> = {
      short: 0,
      standard: 0,
      forensic: 0,
    };

    for (const record of this._records.values()) {
      counts[record.retentionClass] += 1;
      sizes[record.retentionClass] += record.sizeBytes;
    }

    return {
      counts,
      sizes,
      totalCount: this._records.size,
      totalBytes: sizes.short + sizes.standard + sizes.forensic,
    };
  }

  /**
   * Return the current `RetentionConfig` in effect (defaults merged with overrides).
   *
   * Returns a deep clone so callers cannot mutate the internal configuration
   * through nested object references.
   */
  getConfig(): RetentionConfig {
    return {
      short: { ...this._config.short },
      standard: { ...this._config.standard },
      forensic: { ...this._config.forensic },
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Collect records that violate any limit for their class.
   *
   * Evaluation order: age → count → size.
   * Records violating multiple limits are included once.
   */
  private _collectCandidates(): CheckpointRecord[] {
    const classes: RetentionClass[] = ['short', 'standard', 'forensic'];
    const candidateSet = new Set<string>();
    const candidates: CheckpointRecord[] = [];

    for (const cls of classes) {
      const config = this._config[cls];
      const classRecords = this._getClassRecords(cls);
      const clsCandidates = this._evaluateClass(classRecords, config);
      for (const record of clsCandidates) {
        if (!candidateSet.has(record.id)) {
          candidateSet.add(record.id);
          candidates.push(record);
        }
      }
    }

    return candidates;
  }

  /**
   * Return all records for a given retention class, sorted oldest-first.
   */
  private _getClassRecords(cls: RetentionClass): CheckpointRecord[] {
    return Array.from(this._records.values())
      .filter((r) => r.retentionClass === cls)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Apply age, count, and size limits to a sorted list of class records.
   *
   * @param sorted  - Records sorted oldest-first.
   * @param config  - Limits for this class.
   * @returns Records that should be pruned.
   */
  private _evaluateClass(
    sorted: CheckpointRecord[],
    config: RetentionClassConfig,
  ): CheckpointRecord[] {
    const now = this._clock();
    const pruneSet = new Set<string>();

    // 1. Age limit
    for (const record of sorted) {
      if (now - record.createdAt > config.maxAgeMs) {
        pruneSet.add(record.id);
      }
    }

    // 2. Count limit — retain only the newest `maxCount` records.
    const retained = sorted.filter((r) => !pruneSet.has(r.id));
    if (retained.length > config.maxCount) {
      const overflow = retained.length - config.maxCount;
      // Remove oldest first (sorted array is oldest-first).
      for (let i = 0; i < overflow; i++) {
        pruneSet.add(retained[i]!.id);
      }
    }

    // 3. Size limit — trim oldest until total size fits.
    const afterCount = retained.filter((r) => !pruneSet.has(r.id));
    let totalSize = afterCount.reduce((sum, r) => sum + r.sizeBytes, 0);
    for (const record of afterCount) {
      if (totalSize <= config.maxSizeBytes) {
        break;
      }
      pruneSet.add(record.id);
      totalSize -= record.sizeBytes;
    }

    return sorted.filter((r) => pruneSet.has(r.id));
  }
}
