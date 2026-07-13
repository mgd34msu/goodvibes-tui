/**
 * Notification dispatch — the production wiring that finally gives the
 * panel_only notification target a live producer.
 *
 * The SDK's NotificationRouter decides where each domain notification goes
 * (conversation / status_bar / panel_only) and collapses bursts and batches.
 * Nothing in the running app routed real notifications before this: the
 * panel_only feed (panels/notifications-feed.ts) and its panel existed with no
 * upstream. This module builds the router, records every panel_only decision
 * (including burst-collapsed ones) into the shared feed, and bridges the
 * runtime event bus so real domain events become notifications.
 */

import { createNotificationRouter, type NotificationRouter } from '@pellux/goodvibes-sdk/platform/runtime/ui';
import type { Notification, RoutingDecision, RuntimeEventBus, RuntimeEventDomain } from '@/runtime/index.ts';
import type { ConfigManager } from '../config/index.ts';
import { getSharedNotificationFeed, type PanelNotificationFeed } from '../panels/notifications-feed.ts';

export interface NotificationDispatcher {
  /** Route a notification; a panel_only (or burst-collapsed) decision lands in the feed. Returns the decision. */
  dispatch(notification: Notification): RoutingDecision;
  /** Surface batch-held notifications (call on a timer / when quiet-typing ends). */
  flush(): void;
  readonly router: NotificationRouter;
}

/**
 * The runtime event domains whose events surface as operational notifications.
 * Deliberately a curated set of user-relevant, completion/attention-shaped
 * domains — not every domain — so the panel reflects meaningful operational
 * activity rather than raw event churn. The router's per-domain verbosity and
 * burst/batch policies still collapse floods within these.
 */
export const NOTIFICATION_BRIDGE_DOMAINS: readonly RuntimeEventDomain[] = [
  'agents',
  'tasks',
  'workflows',
  'automation',
  'deliveries',
  'security',
];

/** Turn an UPPER_SNAKE event type into a short human title ("AGENT_COMPLETED" → "Agent completed"). */
export function humanizeEventType(type: string): string {
  const words = type.toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return type;
  return words.map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ');
}

/** Derive a notification severity from an event type — errors/failures warn, the rest are informational. */
export function levelForEventType(type: string): Notification['level'] {
  const upper = type.toUpperCase();
  if (/(FAILED|ERROR|CRASH|DENIED|BLOCKED)/.test(upper)) return 'warning';
  if (/(CRITICAL|FATAL|BREACH)/.test(upper)) return 'critical';
  return 'info';
}

export function createNotificationDispatcher(
  configManager: Pick<ConfigManager, 'get'>,
  feed: PanelNotificationFeed = getSharedNotificationFeed(),
): NotificationDispatcher {
  const router = createNotificationRouter(undefined, undefined, configManager);
  const recordIfPanel = (notification: Notification, decision: RoutingDecision): void => {
    if (decision.suppressed) return;
    if (decision.target === 'panel_only') feed.record(notification, decision);
  };
  return {
    router,
    dispatch(notification) {
      const decision = router.route(notification);
      recordIfPanel(notification, decision);
      return decision;
    },
    flush() {
      for (const { notification } of router.flush()) {
        // A flushed batch head surfaces as a batch-collapsed panel entry; the
        // feed folds all sharing this batch key into one running-count row.
        feed.record(notification, {
          target: 'panel_only',
          reasonCode: 'batch_window_collapsed',
          batchKey: `${notification.domain}:${notification.level}`,
        });
      }
    },
  };
}

/**
 * Bridge the runtime event bus to the dispatcher: each event in a curated
 * domain becomes a notification and is routed. Returns an unsubscribe function
 * that detaches every domain listener.
 */
export function wireRuntimeNotificationBridge(
  runtimeBus: RuntimeEventBus,
  dispatcher: Pick<NotificationDispatcher, 'dispatch'>,
  domains: readonly RuntimeEventDomain[] = NOTIFICATION_BRIDGE_DOMAINS,
): () => void {
  const unsubscribes = domains.map((domain) =>
    runtimeBus.onDomain(domain, (envelope) => {
      dispatcher.dispatch({
        id: envelope.traceId ?? `${domain}-${envelope.type}-${envelope.ts}`,
        domain,
        level: levelForEventType(envelope.type),
        title: humanizeEventType(envelope.type),
        timestamp: envelope.ts,
      });
    }),
  );
  return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
}
