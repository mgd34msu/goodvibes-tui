/**
 * long-task-notifier — fires push notifications when a turn or agent task
 * completes after running longer than the configured threshold.
 *
 * PRIVACY GUARANTEE: Notification text must never include conversation content
 * (user messages, assistant replies, tool outputs). Only metadata is included:
 * task kind, elapsed time, ok/fail status, and session id. This module enforces
 * that constraint by construction — it receives no conversation object and
 * builds all message text from structural metadata only.
 *
 * Delivery targets (in preference order):
 *   1. Desktop notification (linux notify-send / mac osascript) via SDK
 *      notifyCompletion — detected and dispatched by the SDK; silently
 *      no-ops when the platform does not support it.
 *   2. Configured outbound webhook channel (ntfy topic / webhook URL) via
 *      WebhookNotifier.send() — only fires when the user has URLs configured.
 *
 * When neither target is available the function is an honest no-op (debug log
 * only; no user-facing error spam).
 *
 * Focus tracking: when `focusTracker` is supplied, notifications are
 * gated the same way as the other unfocused-user alert classes (see
 * alert-gating.ts) — they fire when the terminal is unfocused or focus state
 * was never observed, and are suppressed when it's known to be focused,
 * unless `behavior.notifyOnlyWhenUnfocused` is turned off. `focusTracker` is
 * optional and defaults to "always fire" (the behavior before focus gating existed) when
 * omitted, so existing callers that don't have a FocusTracker in scope are
 * unaffected.
 */

import { notifyCompletion } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { readNotifyOnlyWhenUnfocused, type ConfigGet } from '@pellux/goodvibes-sdk/platform/runtime/operations';

/** Default threshold in seconds. Turns shorter than this do not notify. */
export const NOTIFY_AFTER_SECONDS_DEFAULT = 60;

/**
 * Sentinel value for the off-state. When behavior.notifyAfterSeconds is 0,
 * push notifications are disabled (same convention as other numeric-off keys
 * in the config schema).
 */
export const NOTIFY_AFTER_SECONDS_OFF = 0;

/** Accepted task kinds for notification messages. */
export type LongTaskKind = 'turn' | 'agent';

/** Completion status for notification messages. */
export type LongTaskStatus = 'ok' | 'fail';

export interface MaybeNotifyLongTaskOptions {
  /**
   * Elapsed milliseconds for the turn or agent task.
   * Must not include any conversation content.
   */
  readonly elapsedMs: number;

  /** Whether the task completed successfully or failed. */
  readonly status: LongTaskStatus;

  /** Task kind label for the notification body. */
  readonly kind: LongTaskKind;

  /** Session id for correlation. Must not be a PII value. */
  readonly sessionId: string;

  /**
   * Threshold in seconds from config (behavior.notifyAfterSeconds).
   * 0 means off; notifications are suppressed entirely.
   * Should be the raw config value; this function normalises it.
   */
  readonly thresholdSeconds: number;

  /**
   * Outbound webhook notifier. When provided and the user has URLs
   * configured, the notification is also sent to all configured endpoints
   * (e.g. ntfy.sh topics). Optional — absent means outbound delivery is
   * skipped silently.
   */
  readonly webhookNotifier?: WebhookNotifier | null;

  /**
   * Terminal focus tracker. When supplied together with `configGet`,
   * the notification additionally respects behavior.notifyOnlyWhenUnfocused
   * (default on): suppressed when the terminal is known to be focused, fires
   * when unfocused or when focus was never observed. Omit both to preserve
   * the behavior before focus gating existed (always fire once the threshold is met).
   */
  readonly focusTracker?: Pick<FocusTracker, 'shouldAlertWhenUnfocused'> | null;

  /** Config reader used only for the notifyOnlyWhenUnfocused gate above. */
  readonly configGet?: ConfigGet;
}

/**
 * Fires push notifications for a completed long task if the elapsed time
 * exceeds the configured threshold.
 *
 * Returns true when at least one delivery was attempted, false when the
 * call was a no-op (threshold not reached, off-state, or focus-gated off —
 * see `focusTracker`/`configGet` above).
 *
 * PRIVACY: builds message text from structural metadata only (kind, elapsed,
 * status, sessionId). Never includes conversation content.
 */
export function maybeNotifyLongTask(opts: MaybeNotifyLongTaskOptions): boolean {
  const { elapsedMs, status, kind, sessionId, thresholdSeconds, webhookNotifier, focusTracker, configGet } = opts;

  // Off-state: 0 disables notifications entirely.
  if (thresholdSeconds === NOTIFY_AFTER_SECONDS_OFF) {
    logger.debug('long-task-notifier: disabled (threshold=0)');
    return false;
  }

  // Gate: only notify when the task exceeded the threshold.
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds < thresholdSeconds) {
    logger.debug('long-task-notifier: below threshold', { elapsedSeconds, thresholdSeconds });
    return false;
  }

  // Focus gate: only applied when both a tracker and a config reader
  // are supplied. Absent either one, behavior is unchanged from before focus
  // gating existed (always fire once the threshold is met).
  if (focusTracker && configGet && readNotifyOnlyWhenUnfocused(configGet) && !focusTracker.shouldAlertWhenUnfocused()) {
    logger.debug('long-task-notifier: suppressed — terminal focused');
    return false;
  }

  // Build concise, metadata-only message. No conversation text.
  const statusLabel = status === 'ok' ? 'completed' : 'failed';
  const title = `GoodVibes — ${kind} ${statusLabel}`;
  // PRIVACY: message contains only structural metadata, never conversation content.
  const message = `${kind} ${statusLabel} in ${elapsedSeconds}s  ·  session ${sessionId.slice(0, 8)}`;

  // Delivery 1: desktop notification (notify-send on linux, osascript on mac).
  // notifyCompletion is non-throwing; SDK handles platform absence silently.
  try {
    notifyCompletion(title, message, elapsedMs);
  } catch (err) {
    logger.debug('long-task-notifier: desktop notify error', { error: String(err) });
  }

  // Delivery 2: outbound webhook (ntfy / generic endpoint) if configured.
  if (webhookNotifier) {
    const urls = webhookNotifier.getUrls();
    if (urls.length > 0) {
      webhookNotifier.send(message).catch((err: unknown) => {
        logger.debug('long-task-notifier: webhook send error', { error: String(err) });
      });
    } else {
      logger.debug('long-task-notifier: no webhook URLs configured, skipping outbound delivery');
    }
  }

  return true;
}

/**
 * Read behavior.notifyAfterSeconds from a config manager.
 * Returns NOTIFY_AFTER_SECONDS_DEFAULT when the key is absent or invalid.
 * Returns NOTIFY_AFTER_SECONDS_OFF (0) when explicitly set to 0.
 */
export function readNotifyAfterSeconds(configGet: (key: string) => unknown): number {
  const raw = configGet('behavior.notifyAfterSeconds');
  if (raw === 0) return NOTIFY_AFTER_SECONDS_OFF;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return NOTIFY_AFTER_SECONDS_DEFAULT;
}
