/**
 * Summary formatter — produces condensed single-line summaries for batched
 * or grouped notifications destined for the conversation surface. Keeps the
 * main conversation high-signal by collapsing repeated events into a brief
 * human-readable description.
 */

import type { Notification, NotificationLevel } from '../types.ts';

/** Maximum length for a truncated notification body in summaries. */
const MAX_BODY_PREVIEW = 80;

/** Level labels used in summary lines. */
const LEVEL_LABELS: Record<NotificationLevel, string> = {
  critical: 'CRITICAL',
  warning: 'Warning',
  info: 'Info',
  debug: 'Debug',
};

/**
 * Format a single notification as a condensed one-line summary.
 *
 * @param notification - The notification to summarise.
 * @returns A short string suitable for inline conversation display.
 */
export function formatNotificationSummary(notification: Notification): string {
  const label = LEVEL_LABELS[notification.level];
  const body =
    notification.body && notification.body.length > MAX_BODY_PREVIEW
      ? `${notification.body.slice(0, MAX_BODY_PREVIEW)}…`
      : notification.body;

  const parts = [`[${label}] ${notification.title}`];
  if (body) {
    parts.push(body);
  }

  return parts.join(' — ');
}

/**
 * Format a group of related notifications into a single condensed summary
 * line. Used when the batch policy has collapsed multiple events.
 *
 * @param notifications - The notifications to collapse (must be non-empty).
 * @returns A condensed summary string, e.g.
 *          "[Info] Tool progress (×12 events) — last: Wrote 3 files"
 */
export function formatBatchSummary(notifications: Notification[]): string {
  if (notifications.length === 0) {
    return '';
  }

  if (notifications.length === 1) {
    return formatNotificationSummary(notifications[0]);
  }

  const last = notifications[notifications.length - 1];
  const label = LEVEL_LABELS[last.level];
  const count = notifications.length;
  const preview =
    last.body && last.body.length > MAX_BODY_PREVIEW
      ? `${last.body.slice(0, MAX_BODY_PREVIEW)}…`
      : last.body;

  const suffix = preview ? ` — last: ${preview}` : '';
  return `[${label}] ${last.title} (\xD7${count} events)${suffix}`;
}
