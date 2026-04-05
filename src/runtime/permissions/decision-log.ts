/**
 * Structured audit log for permission decisions.
 *
 * DecisionLog provides an in-memory circular buffer of PermissionDecision
 * records with structured output suitable for debugging and compliance auditing.
 *
 * Decisions are appended on every evaluation. The buffer is bounded to prevent
 * unbounded memory growth during long sessions.
 */

import type { PermissionDecision } from './types.ts';

// ── Configuration ─────────────────────────────────────────────────────────────────

/** Maximum number of decisions held in the circular buffer. */
const DEFAULT_MAX_ENTRIES = 1000;

// ── Log entry ─────────────────────────────────────────────────────────────────────

/**
 * A decorated audit log entry wrapping a PermissionDecision with
 * a monotonic sequence number for ordered retrieval.
 */
export interface DecisionLogEntry {
  /** Monotonic sequence number (1-based, increments per decision). */
  seq: number;
  /** The full permission decision record. */
  decision: PermissionDecision;
}

// ── Query filters ─────────────────────────────────────────────────────────────

/** Filters for querying the decision log. */
export interface DecisionLogQuery {
  /** Return only decisions for this tool name. */
  toolName?: string;
  /** Return only allow or only deny decisions. */
  allowed?: boolean;
  /** Return decisions after this timestamp (epoch ms, inclusive). */
  since?: number;
  /** Maximum number of entries to return (default: all). */
  limit?: number;
}

// ── DecisionLog ───────────────────────────────────────────────────────────────────

/**
 * DecisionLog — Bounded circular buffer for permission decision audit records.
 *
 * Thread-safe for single-threaded Bun/Node runtimes (no async gaps in write path).
 * Oldest entries are silently evicted when the buffer is full.
 *
 * Implements a true O(1) ring buffer with head/tail indexing to avoid O(n)
 * Array.shift() evictions.
 */
export class DecisionLog {
  /** Ring buffer storage (fixed-size array). */
  private readonly buffer: (DecisionLogEntry | undefined)[];
  /** Write head: index where next entry will be written. */
  private head = 0;
  /** Total entries currently stored (≤ maxEntries). */
  private count = 0;
  private seq = 0;
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.buffer = new Array(maxEntries);
  }

  /**
   * append — Records a permission decision in the audit log.
   *
   * If the buffer has reached `maxEntries`, the oldest entry is silently evicted
   * in O(1) time via ring buffer head advancement.
   *
   * @param decision — The completed PermissionDecision to record.
   */
  append(decision: PermissionDecision): void {
    this.seq += 1;
    const entry: DecisionLogEntry = { seq: this.seq, decision };
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count += 1;
  }

  /**
   * toArray — Returns all current entries in chronological order (oldest first).
   */
  private toArray(): DecisionLogEntry[] {
    if (this.count === 0) return [];
    const result: DecisionLogEntry[] = new Array(this.count);
    // tail = oldest entry index in ring buffer
    const tail = this.count < this.maxEntries ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result[i] = this.buffer[(tail + i) % this.maxEntries]!;
    }
    return result;
  }

  /**
   * query — Returns filtered log entries in chronological order.
   *
   * @param filters — Optional filter criteria.
   */
  query(filters: DecisionLogQuery = {}): DecisionLogEntry[] {
    let results = this.toArray();

    if (filters.toolName !== undefined) {
      results = results.filter((e) => e.decision.toolName === filters.toolName);
    }
    if (filters.allowed !== undefined) {
      results = results.filter((e) => e.decision.allowed === filters.allowed);
    }
    if (filters.since !== undefined) {
      results = results.filter((e) => e.decision.timestamp >= (filters.since ?? 0));
    }
    if (filters.limit !== undefined && filters.limit > 0) {
      results = results.slice(-filters.limit);
    }

    return results;
  }

  /**
   * latest — Returns the most recent decision, or undefined if the log is empty.
   */
  latest(): DecisionLogEntry | undefined {
    if (this.count === 0) return undefined;
    // Most recent entry is at (head - 1 + maxEntries) % maxEntries
    const latestIdx = (this.head - 1 + this.maxEntries) % this.maxEntries;
    return this.buffer[latestIdx];
  }

  /**
   * size — Returns the current number of entries in the buffer.
   */
  get size(): number {
    return this.count;
  }

  /**
   * totalRecorded — Returns the total number of decisions ever recorded
   * (including evicted entries). Monotonically increasing.
   */
  get totalRecorded(): number {
    return this.seq;
  }

  /**
   * clear — Empties the log and resets the sequence counter.
   * Primarily useful in tests.
   */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.seq = 0;
  }

  /**
   * summary — Returns aggregate counts of allow/deny decisions.
   */
  summary(): { total: number; allowed: number; denied: number; evicted: number } {
    const entries = this.toArray();
    const allowed = entries.filter((e) => e.decision.allowed).length;
    return {
      total: this.count,
      allowed,
      denied: this.count - allowed,
      evicted: Math.max(0, this.seq - this.count),
    };
  }
}
