/**
 * long-task-notifier, fires push notifications when a turn or agent task
 * ends after running longer than the configured threshold.
 *
 * NAMING RULE (owner ruling 2026-09-29): a notification names the work it is
 * about. The title is the turn's name (the user-set conversation title, else
 * the first line of the message that started the turn, trimmed at a word
 * boundary), the body is the outcome: done, failed or cancelled, elapsed time,
 * files changed, tool calls, agents started, review score, and for a failure
 * the reason. Text comes from the SDK's runtime/turn-notification.ts so every
 * channel and host words it the same way.
 *
 * PRIVACY RULE: behavior.notificationsMetadataOnly (default off). When on,
 * every channel this module sends on (desktop and webhook) carries metadata
 * only: the outcome, elapsed time, counts and the session id prefix, never the
 * turn's name or a failure reason. When off, both channels, the webhook
 * included, carry the name and the outcome.
 *
 * Delivery targets (in preference order):
 *   1. Desktop notification (linux notify-send / mac osascript) via SDK
 *      notifyCompletion, detected and dispatched by the SDK; silently
 *      no-ops when the platform does not support it.
 *   2. Configured outbound webhook channel (ntfy topic / webhook URL) via
 *      WebhookNotifier.send(), only fires when the user has URLs configured.
 *
 * When neither target is available the function is an honest no-op (debug log
 * only; no user-facing error spam).
 *
 * Focus tracking: when `focusTracker` is supplied, notifications are
 * gated the same way as the other unfocused-user alert classes (see
 * alert-gating.ts), they fire when the terminal is unfocused or focus state
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
import {
  FORCE_NOTIFY_DURATION_MS,
  buildTurnNotification,
  formatWebhookText,
  readNotificationsMetadataOnly,
  readNotifyOnlyWhenUnfocused,
  type ConfigGet,
  type TurnOutcome,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';

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
   * How the task ended. Overrides `status` when given, so a cancelled turn is
   * told as cancelled rather than failed.
   */
  readonly outcome?: TurnOutcome | undefined;

  /** The turn's name (SDK resolveTurnName). Left out of the text when metadata-only is on. */
  readonly name?: string | null | undefined;

  /** Why a failed or cancelled task stopped. Left out of the text when metadata-only is on. */
  readonly reason?: string | null | undefined;

  /** What the task did (SDK TurnActivityTally.snapshot()). */
  readonly activity?: {
    readonly toolCalls?: number | undefined;
    readonly filesChanged?: number | undefined;
    readonly agentsStarted?: number | undefined;
    readonly reviewScore?: number | null | undefined;
  } | undefined;

  /**
   * behavior.notificationsMetadataOnly. When omitted it is read through
   * `configGet`; with neither, it is the default (off).
   */
  readonly metadataOnly?: boolean | undefined;

  /** Desktop delivery; defaults to the SDK notifyCompletion. Tests pass a spy to read the text. */
  readonly notifyDesktop?: typeof notifyCompletion | undefined;

  /**
   * Threshold in seconds from config (behavior.notifyAfterSeconds).
   * 0 means off; notifications are suppressed entirely.
   * Should be the raw config value; this function normalises it.
   */
  readonly thresholdSeconds: number;

  /**
   * Outbound webhook notifier. When provided and the user has URLs
   * configured, the notification is also sent to all configured endpoints
   * (e.g. ntfy.sh topics). Optional, absent means outbound delivery is
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
 * Fires push notifications for a finished long task if the elapsed time
 * exceeds the configured threshold.
 *
 * Returns true when at least one delivery was attempted, false when the
 * call was a no-op (threshold not reached, off-state, or focus-gated off,
 * see `focusTracker`/`configGet` above).
 *
 * Text: see the NAMING and PRIVACY rules at the top of this file.
 */
export function maybeNotifyLongTask(opts: MaybeNotifyLongTaskOptions): boolean {
  const { elapsedMs, status, kind, sessionId, thresholdSeconds, webhookNotifier, focusTracker, configGet } = opts;
  const notifyDesktop = opts.notifyDesktop ?? notifyCompletion;

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
    logger.debug('long-task-notifier: suppressed; terminal focused');
    return false;
  }

  const metadataOnly = opts.metadataOnly ?? (configGet ? readNotificationsMetadataOnly(configGet) : false);
  const notice = buildTurnNotification({
    outcome: opts.outcome ?? (status === 'ok' ? 'completed' : 'failed'),
    elapsedMs,
    name: opts.name,
    reason: opts.reason,
    sessionId,
    subject: kind,
    ...opts.activity,
  }, { metadataOnly });

  // Delivery 1: desktop notification (notify-send on linux, osascript on mac).
  // notifyCompletion is non-throwing; SDK handles platform absence silently.
  // Its own duration heuristic only pops a desktop notification above 30s;
  // the threshold above is the user's (behavior.notifyAfterSeconds), so a
  // threshold under 30s must still reach the desktop.
  try {
    notifyDesktop(notice.title, notice.body, Math.max(elapsedMs, FORCE_NOTIFY_DURATION_MS));
  } catch (err) {
    logger.debug('long-task-notifier: desktop notify error', { error: String(err) });
  }

  // Delivery 2: outbound webhook (ntfy / generic endpoint) if configured.
  if (webhookNotifier) {
    const urls = webhookNotifier.getUrls();
    if (urls.length > 0) {
      webhookNotifier.send(formatWebhookText(notice)).catch((err: unknown) => {
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
