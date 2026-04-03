/**
 * Notification routing module — barrel export and factory.
 *
 * Implements v3 Section 18.2: conversation noise routing.
 * Operational noise is routed to dedicated panels while the main
 * conversation receives only high-signal items.
 *
 * @example
 * ```ts
 * import { createNotificationRouter } from './notifications/index.ts';
 *
 * const router = createNotificationRouter();
 * router.setDomainVerbosity('tools', 'minimal');
 * router.setQuietWhileTyping(true);
 *
 * const decision = router.route(myNotification);
 * ```
 */

export type {
  NotificationLevel,
  NotificationTarget,
  DomainVerbosity,
  NotificationAction,
  Notification,
  RoutingDecision,
  RoutedNotification,
  DomainConfig,
  RoutingReasonCode,
  NotificationTag,
} from './types.ts';

export { NotificationRouter } from './router.ts';

export {
  applyDefaultPolicy,
  applyQuietTypingPolicy,
  BatchPolicy,
  applyModeContextPolicy,
  BurstPolicy,
} from './policies/index.ts';

export {
  formatNotificationSummary,
  formatBatchSummary,
  createPanelJumpAction,
  createDismissAction,
} from './formatters/index.ts';

import { NotificationRouter } from './router.ts';

/**
 * Factory function — creates a NotificationRouter with default policy stack.
 *
 * @param batchWindowMs - Optional batch window override in milliseconds
 *                        (default: 2000ms).
 * @returns A configured NotificationRouter instance ready for use.
 */
export function createNotificationRouter(
  batchWindowMs?: number,
  adaptiveSuppression?: boolean,
): NotificationRouter {
  return new NotificationRouter(batchWindowMs, adaptiveSuppression);
}
