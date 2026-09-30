/**
 * Notification dispatch, the production wiring that finally gives the
 * panel_only notification target a live producer.
 *
 * The SDK's NotificationRouter decides where each domain notification goes
 * (conversation / status_bar / panel_only) and collapses bursts and batches.
 * Nothing in the running app routed real notifications before this: the
 * panel_only feed (views/notifications-feed.ts) and the notifications modal existed with no
 * upstream. This module builds the router, records every panel_only decision
 * (including burst-collapsed ones) into the shared feed, and bridges the
 * runtime event bus so real domain events become notifications.
 */

import { createNotificationRouter, type NotificationRouter } from '@pellux/goodvibes-sdk/platform/runtime/ui';
import type { Notification, RoutingDecision, RuntimeEventBus, RuntimeEventDomain } from '@/runtime/index.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { getSharedNotificationFeed, type NotificationFeed } from '../views/notifications-feed.ts';
import { publishNotice, type NoticeSink } from '../core/notices.ts';
import { memoryPressureLine, memoryPressureLevel, type MemoryPressurePayload } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import { runtimeEventKey } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap';

export interface NotificationDispatcher {
  /**
   * Route a notification; a panel_only (or burst-collapsed) decision lands in
   * the feed. `eventKey` names the runtime event it came from (the SDK's
   * runtimeEventKey), so the feed keeps one entry when the same event also
   * arrives as a conversation notice. Returns the decision.
   */
  dispatch(notification: Notification, eventKey?: string): RoutingDecision;
  /** Surface batch-held notifications (call on a timer / when quiet-typing ends). */
  flush(): void;
  readonly router: NotificationRouter;
}

/**
 * The runtime event domains whose events surface as operational notifications.
 * Deliberately a curated set of user-relevant, completion/attention-shaped
 * domains, not every domain, so the notifications modal reflects meaningful operational
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

/** A runtime event a person reads in the notification history: its plain title and severity. */
export interface PersonFacingEvent {
  readonly title: string;
  readonly level: Notification['level'];
}

/**
 * The runtime events that become notification-history entries, by event type,
 * with the plain title each one shows. Everything else on the bridged domains
 * (stream deltas, progress ticks, gate results, state changes, queue and start
 * events) is internal traffic and never enters the history: this table is an
 * allowlist, so a new SDK event type stays out until someone names it here.
 */
export const PERSON_FACING_EVENTS: Readonly<Record<string, PersonFacingEvent>> = {
  // agents
  AGENT_COMPLETED: { title: 'Agent finished', level: 'info' },
  AGENT_FAILED: { title: 'Agent failed', level: 'warning' },
  AGENT_CANCELLED: { title: 'Agent cancelled', level: 'info' },
  AGENT_AWAITING_MESSAGE: { title: 'Agent is waiting for a reply', level: 'info' },
  // tasks
  TASK_COMPLETED: { title: 'Task finished', level: 'info' },
  TASK_FAILED: { title: 'Task failed', level: 'warning' },
  TASK_BLOCKED: { title: 'Task blocked', level: 'warning' },
  TASK_CANCELLED: { title: 'Task cancelled', level: 'info' },
  // workflows (review chains)
  WORKFLOW_CHAIN_PASSED: { title: 'Review chain passed', level: 'info' },
  WORKFLOW_CHAIN_FAILED: { title: 'Review chain failed', level: 'warning' },
  WORKFLOW_CASCADE_ABORTED: { title: 'Review chain stopped', level: 'warning' },
  WORKFLOW_AUTO_COMMITTED: { title: 'Reviewed changes committed', level: 'info' },
  WORKFLOW_SCORE_REGRESSION: { title: 'Review score dropped', level: 'warning' },
  // automation (scheduled jobs)
  AUTOMATION_RUN_COMPLETED: { title: 'Scheduled job finished', level: 'info' },
  AUTOMATION_RUN_FAILED: { title: 'Scheduled job failed', level: 'warning' },
  AUTOMATION_JOB_AUTO_DISABLED: { title: 'Scheduled job turned off after repeated failures', level: 'warning' },
  AUTOMATION_SCHEDULE_ERROR: { title: 'Schedule could not be read', level: 'warning' },
  // deliveries (outgoing channel messages)
  DELIVERY_FAILED: { title: 'Message delivery failed', level: 'warning' },
  DELIVERY_DEAD_LETTERED: { title: 'Message could not be delivered', level: 'warning' },
  // security
  AUTH_FAILED: { title: 'Sign-in failed', level: 'warning' },
  COMPANION_PAIR_REQUESTED: { title: 'Device pairing requested', level: 'info' },
  COMPANION_PAIR_VERIFIED: { title: 'Device paired', level: 'info' },
  COMPANION_TOKEN_REVOKED: { title: 'Device access revoked', level: 'info' },
  TOKEN_ROTATION_WARNING: { title: 'Access token expires soon', level: 'warning' },
  TOKEN_ROTATION_EXPIRED: { title: 'Access token expired', level: 'warning' },
  TOKEN_BLOCKED: { title: 'Access token blocked', level: 'warning' },
  TOKEN_SCOPE_VIOLATION: { title: 'Request refused: outside the token\'s permissions', level: 'warning' },
};

/** The history entry an event type makes, or undefined for internal traffic that is not recorded. */
export function personFacingEvent(type: string): PersonFacingEvent | undefined {
  return Object.prototype.hasOwnProperty.call(PERSON_FACING_EVENTS, type) ? PERSON_FACING_EVENTS[type] : undefined;
}

/** The detail line an event payload carries (an error or cancel reason, a chain's landing outcome, or the commit it made), if any. */
export function eventDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  // `note`: a passed review chain's landing outcome (committed, or why not, e.g. a refusing commit hook).
  for (const field of ['error', 'reason', 'note']) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const commit = record['commitHash'];
  if (typeof commit === 'string' && commit.trim()) return `commit ${commit.trim().slice(0, 7)}`;
  return undefined;
}

export function createNotificationDispatcher(
  configManager: Pick<ConfigManager, 'get'>,
  feed: NotificationFeed = getSharedNotificationFeed(),
): NotificationDispatcher {
  const router = createNotificationRouter(undefined, undefined, configManager);
  /** Event keys of notifications the router is holding in a batch, for when the batch is flushed. */
  const heldEventKeys = new WeakMap<Notification, string>();
  const recordIfFeedTarget = (notification: Notification, decision: RoutingDecision, eventKey: string | undefined): void => {
    if (decision.suppressed) return;
    if (decision.target === 'panel_only') feed.record(notification, decision, eventKey);
  };
  return {
    router,
    dispatch(notification, eventKey) {
      const decision = router.route(notification);
      if (eventKey) heldEventKeys.set(notification, eventKey);
      recordIfFeedTarget(notification, decision, eventKey);
      return decision;
    },
    flush() {
      for (const { notification } of router.flush()) {
        // A flushed batch head surfaces as a batch-collapsed feed entry; the
        // feed folds all sharing this batch key into one running-count row.
        feed.record(notification, {
          target: 'panel_only',
          reasonCode: 'batch_window_collapsed',
          batchKey: `${notification.domain}:${notification.level}`,
        }, heldEventKeys.get(notification));
      }
    },
  };
}

/**
 * Bridge OPS_MEMORY_PRESSURE specifically into the notification feed as an
 * attention line. The MemoryGovernor emits this on the 'ops' domain when the
 * pressure tier changes or the leak tripwire fires; that domain also carries
 * high-churn audit/metric events, so it is deliberately NOT in
 * NOTIFICATION_BRIDGE_DOMAINS, this targeted bridge lifts only the
 * memory-pressure event into notices (critical at the critical tier / on a
 * tripwire, warning at high), leaving the rest of the ops churn out of the
 * feed. Returns an unsubscribe function.
 */
export function wireMemoryPressureNotice(
  runtimeBus: RuntimeEventBus,
  dispatcher: Pick<NotificationDispatcher, 'dispatch'>,
): () => void {
  return runtimeBus.onDomain('ops', (envelope) => {
    if (envelope.type !== 'OPS_MEMORY_PRESSURE') return;
    const payload = envelope.payload as MemoryPressurePayload;
    dispatcher.dispatch({
      id: envelope.traceId ?? `ops-OPS_MEMORY_PRESSURE-${envelope.ts}`,
      domain: 'ops',
      level: memoryPressureLevel(payload),
      title: memoryPressureLine(payload),
      timestamp: envelope.ts,
    });
  });
}

/**
 * Bridge the runtime event bus to the dispatcher: each person-facing event
 * (PERSON_FACING_EVENTS) in a curated domain becomes a notification with its
 * plain title and is routed. Internal events are not recorded at all. Returns
 * an unsubscribe function that detaches every domain listener.
 */
export function wireRuntimeNotificationBridge(
  runtimeBus: RuntimeEventBus,
  dispatcher: Pick<NotificationDispatcher, 'dispatch'>,
  domains: readonly RuntimeEventDomain[] = NOTIFICATION_BRIDGE_DOMAINS,
): () => void {
  const unsubscribes = domains.map((domain) =>
    runtimeBus.onDomain(domain, (envelope) => {
      const event = personFacingEvent(envelope.type);
      if (!event) return;
      const body = eventDetail(envelope.payload);
      dispatcher.dispatch({
        id: envelope.traceId ?? `${domain}-${envelope.type}-${envelope.ts}`,
        domain,
        level: event.level,
        title: event.title,
        ...(body ? { body } : {}),
        timestamp: envelope.ts,
      }, runtimeEventKey(envelope.type, envelope.payload));
    }),
  );
  return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
}

/** The shell's conversation notice sink: every system notice is a toast and a history entry (core/notices.ts). */
export function createShellNoticeSink(feed: NotificationFeed = getSharedNotificationFeed()): NoticeSink {
  return (content, { restored }) => publishNotice(feed, content, { restored });
}
