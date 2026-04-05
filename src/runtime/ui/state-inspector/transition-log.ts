/**
 * Bounded transition history log for the state inspector.
 *
 * Maintains a ring-buffer of the most recent N state transitions.
 * When the buffer is full, oldest entries are evicted (FIFO).
 * All operations are O(1) amortised.
 *
 * State inspector transition log.
 */
import type { TransitionEntry } from './types.ts';
import { DEFAULT_MAX_TRANSITIONS } from './types.ts';

/**
 * BoundedTransitionLog — a fixed-capacity log of state transitions.
 *
 * Each call to `append()` stores a new entry. When capacity is
 * exceeded, the oldest entry is silently dropped.
 */
export class BoundedTransitionLog {
  private readonly _maxSize: number;
  /** Circular buffer storage. */
  private readonly _entries: (TransitionEntry | undefined)[];
  /** Index at which the next write will occur. */
  private _head: number = 0;
  /** Total number of entries ever appended (not capped at _maxSize). */
  private _totalAppended: number = 0;
  /** Monotonic entry ID counter. */
  private _nextId: number = 1;

  /**
   * @param maxSize - Maximum number of entries to retain. Must be >= 1.
   * @default DEFAULT_MAX_TRANSITIONS
   */
  constructor(maxSize: number = DEFAULT_MAX_TRANSITIONS) {
    if (maxSize < 1) throw new RangeError(`maxSize must be >= 1, got ${maxSize}`);
    this._maxSize = maxSize;
    this._entries = new Array<TransitionEntry | undefined>(maxSize).fill(undefined);
  }

  /** Maximum number of entries this log can retain. */
  get maxSize(): number {
    return this._maxSize;
  }

  /** Total entries ever appended (monotonically increasing). */
  get totalAppended(): number {
    return this._totalAppended;
  }

  /** Number of entries currently retained (capped at maxSize). */
  get size(): number {
    return Math.min(this._totalAppended, this._maxSize);
  }

  /**
   * Append a new transition to the log.
   * Evicts the oldest entry if the buffer is full.
   *
   * @param entry - The transition entry to record (without an `id`).
   *   The `id` field is assigned by the log.
   * @returns The stored TransitionEntry with its assigned `id`.
   */
  public append(
    entry: Omit<TransitionEntry, 'id'>,
  ): TransitionEntry {
    const stored: TransitionEntry = { ...entry, id: this._nextId++ };
    this._entries[this._head] = stored;
    this._head = (this._head + 1) % this._maxSize;
    this._totalAppended++;
    return stored;
  }

  /**
   * Return all retained entries in chronological order (oldest → newest).
   *
   * Performance note: allocates a new array per call. At the default
   * maxSize of 1000 this is acceptable for devtools use. Direct ring-buffer
   * iteration without allocation is a follow-up optimisation if needed.
   *
   * @returns Ordered array of TransitionEntry.
   */
  public getAll(): TransitionEntry[] {
    if (this._totalAppended === 0) return [];

    const count = this.size;
    const result: TransitionEntry[] = new Array<TransitionEntry>(count);

    // If buffer not yet full, entries are in order from index 0
    if (this._totalAppended <= this._maxSize) {
      for (let i = 0; i < count; i++) {
        result[i] = this._entries[i] as TransitionEntry;
      }
      return result;
    }

    // Buffer is full: oldest entry is at _head (next write position)
    for (let i = 0; i < count; i++) {
      result[i] = this._entries[(this._head + i) % this._maxSize] as TransitionEntry;
    }
    return result;
  }

  /**
   * Return entries filtered by domain name.
   *
   * @param domain - Domain to filter by.
   * @returns Ordered entries for the given domain.
   */
  public getByDomain(domain: string): TransitionEntry[] {
    return this.getAll().filter((e) => e.domain === domain);
  }

  /**
   * Return entries recorded at or after a given epoch ms timestamp.
   *
   * @param sinceMs - Inclusive lower bound (epoch ms).
   * @returns Ordered entries at or after the timestamp.
   */
  public getSince(sinceMs: number): TransitionEntry[] {
    return this.getAll().filter((e) => e.recordedAt >= sinceMs);
  }

  /**
   * Return the N most recent entries.
   *
   * @param n - Number of entries to return.
   * @returns Slice of at most N entries, most recent last.
   */
  public getLast(n: number): TransitionEntry[] {
    const all = this.getAll();
    return n >= all.length ? all : all.slice(all.length - n);
  }

  /**
   * Clear all retained entries and reset counters.
   * The capacity remains unchanged.
   */
  public clear(): void {
    this._entries.fill(undefined);
    this._head = 0;
    this._totalAppended = 0;
    this._nextId = 1;
  }
}
