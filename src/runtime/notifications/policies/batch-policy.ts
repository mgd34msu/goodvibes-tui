/**
 * Batch policy — collapses repeated notifications from the same domain +
 * level within a rolling time window to prevent UI flooding from high-
 * frequency operational events (e.g. tool progress ticks, agent heartbeats).
 */

import type { Notification } from '../types.ts';

/** Default batch window in milliseconds. */
const DEFAULT_BATCH_WINDOW_MS = 2_000;

/** Record of the last notification seen per batch group key. */
interface BatchEntry {
  /** The last notification seen in this group. */
  last: Notification;
  /** How many notifications have arrived in the current window. */
  count: number;
  /** Timestamp when the current batch window opened. */
  windowStart: number;
}

/**
 * BatchPolicy tracks repeated notifications and decides whether a new
 * arrival should be collapsed into an existing batch group.
 *
 * A batch group key is `{domain}:{level}`. Two notifications sharing the
 * same key within `batchWindowMs` are considered duplicates.
 */
export class BatchPolicy {
  /** Active batch groups keyed by `{domain}:{level}`. */
  private readonly groups = new Map<string, BatchEntry>();

  /** Pending flushed notifications paired with their batch count. */
  private readonly pending: Array<{ notification: Notification; batchCount: number }> = [];

  /** Rolling window in ms within which repeated notifications are batched. */
  private readonly batchWindowMs: number;

  constructor(batchWindowMs: number = DEFAULT_BATCH_WINDOW_MS) {
    this.batchWindowMs = batchWindowMs;
  }

  /**
   * Builds the batch group key for a notification.
   *
   * @param notification - The notification to key.
   * @returns A string key in the form `{domain}:{level}`.
   */
  private buildKey(notification: Notification): string {
    return `${notification.domain}:${notification.level}`;
  }

  /**
   * Evaluates a notification against the batch policy.
   *
   * @param notification - Incoming notification to evaluate.
   * @returns The batch group key if this notification is being batched,
   *          or undefined if it should be routed immediately.
   */
  evaluate(notification: Notification): string | undefined {
    const key = this.buildKey(notification);
    const now = notification.timestamp;
    const entry = this.groups.get(key);

    if (!entry) {
      // First notification in this group — start a new window.
      this.groups.set(key, { last: notification, count: 1, windowStart: now });
      // First in group is NOT batched — route immediately.
      return undefined;
    }

    const windowExpired = now - entry.windowStart > this.batchWindowMs;

    if (windowExpired) {
      // Window has expired — flush the held batch and start fresh.
      this.pending.push({ notification: entry.last, batchCount: entry.count });
      this.groups.set(key, { last: notification, count: 1, windowStart: now });
      // New window start is NOT batched.
      return undefined;
    }

    // Within window — collapse into batch.
    entry.last = notification;
    entry.count += 1;
    return key;
  }

  /**
   * Flushes all pending batched notifications.
   *
   * Call this at the end of a batch cycle (e.g. on a timer tick or when
   * quiet-typing mode ends) to surface collapsed notifications.
   *
   * @param now - Optional timestamp override for expiry checks (defaults to Date.now()).
   * @returns Array of the most-recent notification from each expired batch group, paired with batch count.
   */
  flush(now: number = Date.now()): Array<{ notification: Notification; batchCount: number }> {
    const flushed: Array<{ notification: Notification; batchCount: number }> = [...this.pending];
    this.pending.length = 0;

    for (const [key, entry] of this.groups) {
      const windowExpired = now - entry.windowStart > this.batchWindowMs;
      if (windowExpired) {
        flushed.push({ notification: entry.last, batchCount: entry.count });
        this.groups.delete(key);
      }
    }

    return flushed;
  }
}
