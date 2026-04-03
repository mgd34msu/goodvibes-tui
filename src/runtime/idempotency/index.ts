/**
 * Idempotency — store and key generation.
 *
 * Provides an in-process idempotency store for tool-call deduplication across
 * replay, reconnect, and restart scenarios. Keys are deterministic (derived from
 * session + turn + call identifiers) so the same logical call always maps to the
 * same key regardless of when it is submitted.
 *
 * Lifecycle:
 *   1. Before executing a tool, call `checkAndRecord(key)`.
 *      - `'new'`       → proceed with execution.
 *      - `'in-flight'` → a prior submission is still running; reject or wait.
 *      - `'duplicate'` → a prior submission completed; return cached result.
 *   2. On success, call `markComplete(key, result)` to cache the result.
 *   3. On failure, call `markFailed(key)` to allow a retry on the next attempt.
 *
 * TTL-based eviction runs automatically whenever the store exceeds `maxRecords`.
 * In-flight records are never evicted.
 */

import { createHash } from 'node:crypto';
import type {
  IdempotencyKeyContext,
  IdempotencyRecord,
  IdempotencyStoreConfig,
} from './types.ts';

export type { IdempotencyKeyContext, IdempotencyRecord, IdempotencyStoreConfig } from './types.ts';
export type { IdempotencyStatus } from './types.ts';

/** Default TTL: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

/** Default maximum stored records before eviction sweep. */
const DEFAULT_MAX_RECORDS = 5_000;

/**
 * IdempotencyStore — bounded, TTL-evicted in-process store.
 *
 * Thread safety: Node.js is single-threaded; no locking is required.
 * Suitable for in-process use within a single runtime session.
 *
 * @example
 * ```ts
 * const store = new IdempotencyStore({ ttlMs: 5 * 60_000 });
 * const key = store.generateKey({ sessionId, turnId, callId });
 * const check = store.checkAndRecord(key);
 * if (check.status === 'new') {
 *   const result = await doWork();
 *   store.markComplete(key, result);
 *   return result;
 * } else if (check.status === 'duplicate') {
 *   return check.record.result; // cached
 * } else {
 *   throw new Error('Tool call already in-flight');
 * }
 * ```
 */
export class IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(config: IdempotencyStoreConfig = {}) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = config.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  // ---------------------------------------------------------------------------
  // Key generation
  // ---------------------------------------------------------------------------

  /**
   * Generate a deterministic idempotency key from a call context.
   *
   * Uses a SHA-256 hash of `sessionId:turnId:callId` to produce a compact,
   * collision-resistant key that is stable across restarts (given the same inputs).
   *
   * @param context - Session, turn, and call identifiers.
   * @returns Hex-encoded SHA-256 digest (64 characters).
   */
  generateKey(context: IdempotencyKeyContext): string {
    return createHash('sha256')
      .update(`${context.sessionId}:${context.turnId}:${context.callId}`)
      .digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /**
   * Check whether a key has been seen before and record it as `in-flight` if new.
   *
   * Returns a discriminated union:
   * - `{ status: 'new' }`        — key is unseen; record created and marked in-flight.
   * - `{ status: 'in-flight' }`  — a prior submission is still running.
   * - `{ status: 'duplicate', record }` — prior submission completed; record holds cached result.
   *
   * @param key - Idempotency key from `generateKey`.
   */
  checkAndRecord(
    key: string,
  ):
    | { readonly status: 'new' }
    | { readonly status: 'in-flight'; readonly record: IdempotencyRecord }
    | { readonly status: 'duplicate'; readonly record: IdempotencyRecord } {
    const existing = this.store.get(key);

    if (existing) {
      if (existing.status === 'in-flight') {
        return { status: 'in-flight', record: existing };
      }
      if (existing.status === 'failed') {
        // Failed records allow retry — delete and fall through to register as new.
        this.store.delete(key);
      } else {
        // completed — return cached result to duplicate callers
        return { status: 'duplicate', record: existing };
      }
    }

    // New key — record as in-flight
    const record: IdempotencyRecord = {
      key,
      status: 'in-flight',
      createdAt: Date.now(),
    };
    this.store.set(key, record);
    this._maybeSweep();

    return { status: 'new' };
  }

  /**
   * Mark a previously recorded key as `completed` and cache the result.
   *
   * No-op if the key is not in the store (e.g. evicted before completion).
   *
   * @param key    - Idempotency key.
   * @param result - Optional result to cache for duplicate callers.
   */
  markComplete(key: string, result?: unknown): void {
    const record = this.store.get(key);
    if (!record) return; // evicted — treat as best-effort
    record.status = 'completed';
    record.completedAt = Date.now();
    if (result !== undefined) {
      record.result = result;
    }
  }

  /**
   * Mark a previously recorded key as `failed`, allowing a subsequent retry.
   *
   * The record transitions from `in-flight` → `failed`. On the next call to
   * `checkAndRecord` with the same key the failed record is deleted and the
   * caller receives `'new'`, allowing a fresh retry.
   *
   * No-op if the key is not in the store.
   *
   * @param key - Idempotency key.
   */
  markFailed(key: string): void {
    const record = this.store.get(key);
    if (!record) return;
    record.status = 'failed';
    record.completedAt = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Inspection
  // ---------------------------------------------------------------------------

  /**
   * Look up a record by key without changing its state.
   *
   * @param key - Idempotency key.
   * @returns The record, or `undefined` if not found or already evicted.
   */
  getRecord(key: string): IdempotencyRecord | undefined {
    return this.store.get(key);
  }

  /**
   * Returns the current number of records in the store (including in-flight).
   */
  get size(): number {
    return this.store.size;
  }

  // ---------------------------------------------------------------------------
  // TTL eviction
  // ---------------------------------------------------------------------------

  /**
   * Evict completed and failed records whose age exceeds the configured TTL.
   *
   * Called automatically by `checkAndRecord` when the store is near capacity.
   * May also be called explicitly (e.g. on a periodic timer).
   *
   * In-flight records are never evicted.
   */
  sweep(): void {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    for (const [key, record] of this.store) {
      if (record.status !== 'in-flight' && record.createdAt < cutoff) {
        this.store.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Trigger a sweep when the store reaches 80% of the configured maximum. */
  private _maybeSweep(): void {
    if (this.store.size >= Math.floor(this.maxRecords * 0.8)) {
      this.sweep();
    }
  }
}

/**
 * Shared singleton IdempotencyStore for the default runtime.
 *
 * TTL defaults to 5 minutes. Callers requiring different TTLs should
 * construct their own `IdempotencyStore` instance.
 *
 * @remarks
 * This singleton is intended for single-runtime use only. Tests and isolated
 * subsystems should construct their own `IdempotencyStore` instance to avoid
 * cross-test state contamination.
 */
export const idempotencyStore = new IdempotencyStore();
