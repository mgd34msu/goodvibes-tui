/**
 * Burst policy — detects rapid notification floods within a short observation
 * window and collapses them into a batch group key.
 *
 * Unlike the rolling BatchPolicy (which uses a fixed time window), the burst
 * policy measures the event rate within a sliding observation window and
 * activates only when the rate exceeds a configured threshold. Once activated,
 * subsequent notifications in the group are collapsed until the burst subsides.
 *
 * A burst group key is `{domain}:{level}` — matching the BatchPolicy scheme
 * so downstream consumers can coalesce both batch types uniformly.
 */

import type { Notification } from '../types.ts';

/** Default observation window for rate measurement. */
const DEFAULT_OBSERVATION_WINDOW_MS = 1_000;

/** Default event count threshold that activates burst suppression. */
const DEFAULT_BURST_THRESHOLD = 3;

/** Default cooldown period after the last burst event before the group resets. */
const DEFAULT_COOLDOWN_MS = 3_000;

/** Internal tracking record for a single burst group. */
interface BurstEntry {
  /** Timestamps of arrivals within the current observation window. */
  timestamps: number[];
  /** Whether this group is currently in active burst suppression. */
  active: boolean;
  /** Timestamp of the most recent notification in this group. */
  lastSeen: number;
  /** Total notifications collapsed in this burst. */
  collapsedCount: number;
}

/**
 * BurstPolicy tracks notification arrival rates per domain:level group and
 * activates burst suppression when the rate exceeds the threshold.
 */
export class BurstPolicy {
  /** Active burst group entries keyed by `{domain}:{level}`. */
  private readonly groups = new Map<string, BurstEntry>();

  /** Observation window in ms. */
  private readonly observationWindowMs: number;

  /** Number of events within the window before burst activates. */
  private readonly burstThreshold: number;

  /** Cooldown in ms after last event before the burst group resets. */
  private readonly cooldownMs: number;

  constructor(
    observationWindowMs: number = DEFAULT_OBSERVATION_WINDOW_MS,
    burstThreshold: number = DEFAULT_BURST_THRESHOLD,
    cooldownMs: number = DEFAULT_COOLDOWN_MS
  ) {
    this.observationWindowMs = Math.max(1, observationWindowMs);
    this.burstThreshold = Math.max(1, burstThreshold);
    this.cooldownMs = Math.max(0, cooldownMs);
  }

  /**
   * Builds the burst group key for a notification.
   *
   * @param notification - The notification to key.
   * @returns A string key in the form `{domain}:{level}`.
   */
  private buildKey(notification: Notification): string {
    return `${notification.domain}:${notification.level}`;
  }

  /**
   * Prune timestamps outside the current observation window.
   */
  private pruneWindow(entry: BurstEntry, now: number): void {
    const cutoff = now - this.observationWindowMs;
    entry.timestamps = entry.timestamps.filter((t) => t >= cutoff);
  }

  /**
   * Evaluates a notification against the burst policy.
   *
   * @param notification - Incoming notification to evaluate.
   * @returns The burst group key if the notification is being burst-collapsed,
   *          or undefined if it should proceed to the next policy stage.
   */
  evaluate(notification: Notification): string | undefined {
    const key = this.buildKey(notification);
    const now = notification.timestamp;

    let entry = this.groups.get(key);

    if (!entry) {
      entry = { timestamps: [], active: false, lastSeen: now, collapsedCount: 0 };
      this.groups.set(key, entry);
    }

    // Expire cooldown: if the group was active but the last event is beyond
    // the cooldown window, reset it.
    if (entry.active && now - entry.lastSeen > this.cooldownMs) {
      entry.active = false;
      entry.collapsedCount = 0;
      entry.timestamps = [];
    }

    this.pruneWindow(entry, now);
    entry.timestamps.push(now);
    entry.lastSeen = now;

    const rate = entry.timestamps.length;

    if (entry.active) {
      // Already in burst mode — collapse this notification.
      entry.collapsedCount += 1;
      return key;
    }

    if (rate > this.burstThreshold) {
      // Rate exceeded threshold — activate burst suppression.
      entry.active = true;
      entry.collapsedCount += 1;
      return key;
    }

    return undefined;
  }

  /**
   * Returns the number of notifications collapsed in a burst group.
   *
   * @param key - The burst group key (`{domain}:{level}`).
   * @returns The collapsed count, or 0 if no group exists.
   */
  getCollapsedCount(key: string): number {
    return this.groups.get(key)?.collapsedCount ?? 0;
  }

  /**
   * Resets a specific burst group, clearing its state.
   * Call this when the burst window expires and the group is ready to
   * surface its summary.
   *
   * @param key - The burst group key to reset.
   */
  resetGroup(key: string): void {
    this.groups.delete(key);
  }

  /**
   * Returns all currently active burst group keys.
   *
   * Callers can use this to surface summary notifications for each active
   * burst group at flush time.
   */
  getActiveGroups(): string[] {
    return Array.from(this.groups.entries())
      .filter(([, entry]) => entry.active)
      .map(([key]) => key);
  }
}
