/**
 * Idempotency — types.
 *
 * Defines the record structure and configuration for the in-process idempotency
 * store used by the phased tool executor and orchestrator turn submission.
 */

/**
 * Lifecycle status of an idempotency record.
 *
 * - `in-flight`  — execution has started but not yet completed.
 * - `completed`  — execution finished successfully; result is cached.
 * - `failed`     — execution finished with an error; `checkAndRecord` will return `'new'` allowing retry.
 */
export type IdempotencyStatus = 'in-flight' | 'completed' | 'failed';

/**
 * A single idempotency record stored per unique key.
 */
export interface IdempotencyRecord {
  /** The idempotency key that identifies this operation. */
  readonly key: string;
  /** Current lifecycle status. */
  status: IdempotencyStatus;
  /** Unix timestamp (ms) when the record was first created. */
  readonly createdAt: number;
  /** Unix timestamp (ms) when the record transitioned out of `in-flight`. */
  completedAt?: number;
  /**
   * Cached result from a completed execution.
   * Returned verbatim to duplicate callers instead of re-running the operation.
   */
  result?: unknown;
}

/**
 * Input context used to generate a deterministic idempotency key.
 *
 * All three fields are required because:
 * - `sessionId`   — scopes keys to a single session (prevents cross-session collisions).
 * - `turnId`      — distinguishes between turns in the same session.
 * - `callId`      — distinguishes between concurrent tool calls in the same turn.
 */
export interface IdempotencyKeyContext {
  /** Stable session identifier. */
  readonly sessionId: string;
  /** Per-turn identifier. */
  readonly turnId: string;
  /** Per-tool-call identifier. */
  readonly callId: string;
}

/**
 * Configuration for `IdempotencyStore`.
 */
export interface IdempotencyStoreConfig {
  /**
   * Time-to-live for completed/failed records in milliseconds.
   *
   * Records older than this value are eligible for eviction.
   * In-flight records are never evicted.
   *
   * @default 300_000 (5 minutes)
   */
  ttlMs?: number;
  /**
   * Maximum number of records retained before a sweep evicts TTL-expired entries.
   *
   * @default 5_000
   */
  maxRecords?: number;
}
