/**
 * Timeline buffer for state inspector time-travel.
 *
 * Maintains a bounded circular buffer of timeline events. Each event records
 * a full domain snapshot so an operator can step backward/forward through
 * state history without re-running mutations.
 *
 * Step controls:
 *   - `stepBack()` / `stepForward()` — move the cursor one position.
 *   - `seekTo(index)` — jump to an absolute index.
 *   - `seekToTime(epochMs)` — seek to the nearest event at or before a timestamp.
 *   - `exitTimeTravel()` — return the cursor to the live tail.
 *
 * The "live" position is represented as cursor === size (one past the last
 * stored event). When live, `getCurrentSnapshot()` returns undefined, signalling
 * that callers should use the inspector's live snapshot instead.
 */
import type { TimelineEvent, TimeTravelCursor } from './types.ts';
import { DEFAULT_TIMELINE_BUFFER_SIZE } from './types.ts';

/**
 * TimelineBuffer — fixed-capacity ring buffer of TimelineEvent snapshots.
 *
 * Indices are stable within a session (they increment monotonically via
 * the `seq` field on each event). The cursor is an offset into the live
 * ring: 0 = oldest retained, size-1 = newest, size = live.
 */
export class TimelineBuffer {
  private readonly _maxSize: number;
  private readonly _ring: (TimelineEvent | undefined)[];
  private _head: number = 0; // next write position
  private _totalAppended: number = 0;
  private _cursor: number; // live by default
  private _nextSeq: number = 1;

  /**
   * @param maxSize — Maximum events to retain. Must be >= 2.
   * @default DEFAULT_TIMELINE_BUFFER_SIZE
   */
  constructor(maxSize: number = DEFAULT_TIMELINE_BUFFER_SIZE) {
    if (maxSize < 2) throw new RangeError(`maxSize must be >= 2, got ${maxSize}`);
    this._maxSize = maxSize;
    this._ring = new Array<TimelineEvent | undefined>(maxSize).fill(undefined);
    this._cursor = 0; // starts at live (size === 0 initially)
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  /** Maximum events retained. */
  get maxSize(): number {
    return this._maxSize;
  }

  /** Current number of events retained (capped at maxSize). */
  get size(): number {
    return Math.min(this._totalAppended, this._maxSize);
  }

  /** Total events ever appended (monotonically increasing). */
  get totalAppended(): number {
    return this._totalAppended;
  }

  // ── Cursor state ─────────────────────────────────────────────────────────

  /**
   * Whether the cursor is at the live position (past the newest event).
   * When live, `getCurrentSnapshot()` returns undefined.
   */
  get isLive(): boolean {
    return this._cursor >= this.size;
  }

  /** Current cursor state for display. */
  get cursorState(): TimeTravelCursor {
    const s = this.size;
    return {
      index: this._cursor,
      total: s,
      isLive: this.isLive,
    };
  }

  // ── Append ────────────────────────────────────────────────────────────────

  /**
   * Append a new timeline event.
   *
   * If the cursor is live it advances with the tail (stays live).
   * If the cursor is pinned (time-travel mode), it stays pinned.
   *
   * @param event — Event without `seq` (assigned here).
   * @returns The stored TimelineEvent with its assigned `seq`.
   */
  public append(event: Omit<TimelineEvent, 'seq'>): TimelineEvent {
    const wasLive = this.isLive;
    const stored: TimelineEvent = { ...event, seq: this._nextSeq++ };
    this._ring[this._head] = stored;
    this._head = (this._head + 1) % this._maxSize;
    this._totalAppended++;

    // Advance cursor only when live
    if (wasLive) {
      this._cursor = this.size; // stay at live
    }
    return stored;
  }

  // ── Random access ─────────────────────────────────────────────────────────

  /**
   * Return all retained events in chronological order.
   *
   * @returns Events oldest → newest.
   */
  public getAll(): TimelineEvent[] {
    const s = this.size;
    if (s === 0) return [];
    const result: TimelineEvent[] = new Array<TimelineEvent>(s);
    if (this._totalAppended <= this._maxSize) {
      for (let i = 0; i < s; i++) {
        result[i] = this._ring[i] as TimelineEvent;
      }
    } else {
      for (let i = 0; i < s; i++) {
        result[i] = this._ring[(this._head + i) % this._maxSize] as TimelineEvent;
      }
    }
    return result;
  }

  /**
   * Return the event at a logical index (0 = oldest, size-1 = newest).
   *
   * @returns TimelineEvent or undefined when out of range.
   */
  public getAt(index: number): TimelineEvent | undefined {
    const s = this.size;
    if (index < 0 || index >= s) return undefined;
    if (this._totalAppended <= this._maxSize) {
      return this._ring[index];
    }
    return this._ring[(this._head + index) % this._maxSize];
  }

  // ── Time-travel controls ──────────────────────────────────────────────────

  /**
   * Return the event at the current cursor position, or undefined when live.
   */
  public getCurrentEvent(): TimelineEvent | undefined {
    if (this.isLive) return undefined;
    return this.getAt(this._cursor);
  }

  /**
   * Step the cursor one event backward (toward oldest).
   * If already at index 0, the cursor stays at 0.
   *
   * @returns true if the cursor moved.
   */
  public stepBack(): boolean {
    if (this._cursor <= 0) return false;
    this._cursor--;
    return true;
  }

  /**
   * Step the cursor one event forward (toward live).
   * When the cursor reaches the live position (past the newest event),
   * `isLive` becomes true.
   *
   * @returns true if the cursor moved.
   */
  public stepForward(): boolean {
    if (this.isLive) return false;
    this._cursor++;
    return true;
  }

  /**
   * Seek the cursor to an absolute logical index.
   * Clamps to [0, size] where size === live.
   *
   * @param index — Target index (size = live).
   */
  public seekTo(index: number): void {
    const s = this.size;
    this._cursor = Math.max(0, Math.min(index, s));
  }

  /**
   * Seek to the nearest event at or before a given epoch ms timestamp.
   * If no events exist before the timestamp, seeks to index 0.
   * If all events are before or equal, seeks to the newest.
   *
   * @param epochMs — Target timestamp.
   */
  public seekToTime(epochMs: number): void {
    const all = this.getAll();
    if (all.length === 0) return;

    let best = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i].capturedAt <= epochMs) {
        best = i;
      } else {
        break;
      }
    }
    this._cursor = best;
  }

  /**
   * Return the cursor to the live tail (exit time-travel mode).
   */
  public exitTimeTravel(): void {
    this._cursor = this.size;
  }

  /**
   * Clear all retained events and reset to live position.
   */
  public clear(): void {
    this._ring.fill(undefined);
    this._head = 0;
    this._totalAppended = 0;
    this._cursor = 0;
    this._nextSeq = 1;
  }
}
