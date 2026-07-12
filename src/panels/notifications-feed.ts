/**
 * PanelNotificationFeed — the read-model behind the `panel_only` notification
 * target.
 *
 * The SDK's NotificationRouter (`@/runtime/index.ts` -> platform runtime `ui`
 * barrel) can route a notification's `RoutingDecision.target` to
 * `'panel_only'`, meaning: don't surface this in the conversation or the
 * status bar, but it must still reach a real, visible place. Before this
 * file, nothing in this repo consumed that target outside of tests — a
 * panel-routed notification (including every burst- or batch-collapsed one)
 * had nowhere to go. This feed is that place: a caller holding a routed
 * `Notification` + `RoutingDecision` pair calls `record()`, and
 * `notifications-panel.ts` renders whatever has accumulated.
 *
 * Collapsed groups (reasonCode `burst_collapsed` / `batch_window_collapsed`)
 * are tracked by their `batchKey` and accumulate an honest running count
 * instead of rendering one row per suppressed duplicate.
 *
 * Production wiring — something in the running app actually calling
 * `record()` with live notifications — rides the SDK round that turns on
 * adaptive notification suppression by default; this feed and its panel are
 * the render target that work lands on, built ahead of it so the target is
 * never missing when that switch flips.
 */
import type { Notification, RoutingDecision } from '@/runtime/index.ts';

export interface PanelFeedEntry {
  readonly key: string;
  readonly domain: string;
  readonly level: Notification['level'];
  readonly title: string;
  readonly body: string | undefined;
  /** Unix ms of the most recent notification folded into this entry. */
  readonly timestamp: number;
  readonly reasonCode: RoutingDecision['reasonCode'];
  /** How many notifications this entry represents. 1 for a standalone item; >1 for a collapsed group. Always the true count — never estimated. */
  readonly collapsedCount: number;
}

const MAX_ENTRIES = 200;

/** Reason codes whose notifications fold into one running-count entry per batch key, rather than one entry per occurrence. */
const COLLAPSING_REASON_CODES: ReadonlySet<RoutingDecision['reasonCode']> = new Set([
  'burst_collapsed',
  'batch_window_collapsed',
]);

export class PanelNotificationFeed {
  private readonly entries = new Map<string, PanelFeedEntry>();
  /** Insertion order of `entries` keys (oldest first), for bounded eviction. */
  private order: string[] = [];
  private readonly listeners = new Set<() => void>();

  /**
   * Record a routed notification. Only notifications actually targeted at
   * `panel_only` are kept — a caller passing anything else is a mistake (the
   * router sent it elsewhere), so it's dropped rather than shown in the
   * wrong place.
   */
  record(notification: Notification, decision: RoutingDecision): void {
    if (decision.target !== 'panel_only') return;

    const collapsing = COLLAPSING_REASON_CODES.has(decision.reasonCode) && Boolean(decision.batchKey);
    const key = collapsing ? `group:${decision.batchKey}` : `single:${notification.id}`;
    const previousCount = collapsing ? (this.entries.get(key)?.collapsedCount ?? 0) : 0;

    const entry: PanelFeedEntry = {
      key,
      domain: notification.domain,
      level: notification.level,
      title: notification.title,
      body: notification.body,
      timestamp: notification.timestamp,
      reasonCode: decision.reasonCode,
      collapsedCount: previousCount + 1,
    };

    if (!this.entries.has(key)) {
      this.order.push(key);
      if (this.order.length > MAX_ENTRIES) {
        const evicted = this.order.shift();
        if (evicted !== undefined) this.entries.delete(evicted);
      }
    }
    this.entries.set(key, entry);
    this.emitChange();
  }

  /** Every entry, most recently updated first. */
  list(): readonly PanelFeedEntry[] {
    const items: PanelFeedEntry[] = [];
    for (const key of this.order) {
      const entry = this.entries.get(key);
      if (entry) items.push(entry);
    }
    return items.reverse();
  }

  clear(): void {
    this.entries.clear();
    this.order = [];
    this.emitChange();
  }

  /** Subscribe to feed changes (e.g. to mark a panel dirty). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

let sharedFeed: PanelNotificationFeed | null = null;

/**
 * The process-wide `panel_only` feed. Lazily created so the running app has
 * exactly one feed that every future caller and the NotificationsPanel agree
 * on, while tests construct their own isolated `PanelNotificationFeed`
 * instance instead of reaching for this one.
 */
export function getSharedNotificationFeed(): PanelNotificationFeed {
  if (!sharedFeed) sharedFeed = new PanelNotificationFeed();
  return sharedFeed;
}
