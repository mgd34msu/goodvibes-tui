/**
 * pruner.ts
 *
 * `SnapshotPruner` — handles safe file-system deletion of expired checkpoint
 * artifacts on behalf of `RetentionPolicy`.
 *
 * Safety contract:
 *  - The path must be a non-empty string before any I/O is attempted.
 *  - Each deletion is attempted independently; failures do not abort others.
 *  - Results are collected and returned as a `PruneResult` for audit.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CheckpointRecord, PerClassPruneResult, PruneOptions, PruneResult, RetentionClass } from './types.ts';

// ---------------------------------------------------------------------------
// SnapshotPruner
// ---------------------------------------------------------------------------

/**
 * Deletes checkpoint artifacts from the file system.
 *
 * Accepts an array of `CheckpointRecord` values, validates each path, and
 * performs deletion. Results are aggregated into a single `PruneResult`.
 *
 * @example
 * ```ts
 * const pruner = new SnapshotPruner();
 * const result = await pruner.delete(candidates);
 * console.log(`Deleted ${result.deletedCount} checkpoints`);
 * ```
 */
export class SnapshotPruner {
  /**
   * Delete the provided checkpoint records from the file system.
   *
   * Each record is processed independently so that a single failure does not
   * prevent deletion of other candidates.
   *
   * @param candidates - Records whose artifacts should be removed.
   * @returns `PruneResult` summarising successes and failures.
   */
  async delete(
    candidates: readonly CheckpointRecord[],
    options: PruneOptions = {},
  ): Promise<PruneResult> {
    const { dryRun = false } = options;
    const deletedIds: string[] = [];
    const candidateIds: string[] = [];
    const failedIds: string[] = [];
    const errors: Record<string, string> = {};
    let reclaimedBytes = 0;

    // Build per-class accumulators.
    const byClass: Record<RetentionClass, { deletedIds: string[]; candidateIds: string[]; failedIds: string[]; reclaimedBytes: number }> = {
      short: { deletedIds: [], candidateIds: [], failedIds: [], reclaimedBytes: 0 },
      standard: { deletedIds: [], candidateIds: [], failedIds: [], reclaimedBytes: 0 },
      forensic: { deletedIds: [], candidateIds: [], failedIds: [], reclaimedBytes: 0 },
    };

    for (const record of candidates) {
      const validationError = this._validatePath(record.path);
      if (validationError !== null) {
        failedIds.push(record.id);
        errors[record.id] = validationError;
        byClass[record.retentionClass].failedIds.push(record.id);
        continue;
      }

      if (dryRun) {
        // In dry-run mode record the candidate separately — no deletedIds populated.
        candidateIds.push(record.id);
        byClass[record.retentionClass].candidateIds.push(record.id);
        continue;
      }

      try {
        await fs.unlink(record.path);
        deletedIds.push(record.id);
        reclaimedBytes += record.sizeBytes;
        byClass[record.retentionClass].deletedIds.push(record.id);
        byClass[record.retentionClass].reclaimedBytes += record.sizeBytes;
      } catch (err: unknown) {
        failedIds.push(record.id);
        errors[record.id] = errorMessage(err);
        byClass[record.retentionClass].failedIds.push(record.id);
      }
    }

    const toPerClass = (cls: RetentionClass): PerClassPruneResult => ({
      deletedCount: byClass[cls].deletedIds.length,
      reclaimedBytes: byClass[cls].reclaimedBytes,
      deletedIds: byClass[cls].deletedIds,
      candidateIds: byClass[cls].candidateIds,
      failedIds: byClass[cls].failedIds,
    });

    return {
      deletedCount: deletedIds.length,
      reclaimedBytes,
      deletedIds,
      candidateIds,
      failedIds,
      errors,
      dryRun,
      byClass: {
        short: toPerClass('short'),
        standard: toPerClass('standard'),
        forensic: toPerClass('forensic'),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Validate that a path is safe to delete.
   *
   * Returns an error message string if the path is invalid, or `null` if safe.
   *
   * Guards:
   *  - Path must be a non-empty string.
   *  - Path must be absolute (prevent accidental relative-path deletions).
   *  - Raw path must not contain `..` segments checked BEFORE normalization.
   *    (After `path.normalize()`, traversal sequences are resolved and the `..`
   *    check becomes dead code — e.g. `/foo/../../etc/passwd` normalizes to
   *    `/etc/passwd` which no longer contains `..`.  We therefore inspect the
   *    raw input first.)
   *  - Normalized path must still be absolute as a belt-and-suspenders check.
   */
  private _validatePath(filePath: string): string | null {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      return 'path is empty or not a string';
    }

    // Check the RAW path for traversal BEFORE normalize() resolves them away.
    // Matches `..` only when bounded by path separators or string boundaries,
    // so legitimate names like `v1..2` are accepted.
    if (/(?:^|[/\\])\.\.\.?(?:[/\\]|$)/.test(filePath)) {
      return `path contains traversal segments: ${filePath}`;
    }

    if (!path.isAbsolute(filePath)) {
      return `path is not absolute: ${filePath}`;
    }

    // Belt-and-suspenders: ensure the normalized form is still absolute.
    const normalized = path.normalize(filePath);
    if (!path.isAbsolute(normalized)) {
      return `normalized path is not absolute: ${filePath}`;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from an unknown thrown value.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
