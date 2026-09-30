/**
 * budget-breach-notifier, fires an unfocused-user alert the moment session
 * cost crosses the configured budget threshold (behavior.budgetAlertUsd).
 *
 * One-shot semantics: fires exactly once on the false→true edge (crossing
 * into breach), never again while still over budget on every subsequent
 * turn. The "already notified" latch resets when the session drops back
 * under budget (so a later re-breach can fire again) or when the threshold
 * itself changes (raising, lowering, or clearing the budget re-arms it
 * against the new value).
 *
 * Delivery mirrors long-task-notifier.ts: desktop notification
 * (notifyCompletion) + outbound webhook (WebhookNotifier), both gated by
 * the shared focus/config gating in alert-gating.ts. Skips evaluation
 * entirely when the session model is unpriced, a $0 placeholder cost must
 * never be reported as a real breach (mirrors the usage modal's "unpriced"
 * display convention).
 *
 * Text (owner ruling 2026-09-29, SDK runtime/turn-notification.ts): the
 * notice names the budget that tripped (cost against the configured
 * threshold) and the turn during which it tripped. When
 * behavior.notificationsMetadataOnly is on (default off) the desktop and
 * webhook text carries the numbers and the session id prefix only.
 */
import { notifyCompletion } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { calcSessionCost, computeBudgetBreach, isModelPriced } from '@pellux/goodvibes-sdk/platform/providers';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import {
  shouldFireAlert,
  FORCE_NOTIFY_DURATION_MS,
  buildBudgetNotification,
  formatWebhookText,
  readNotificationsMetadataOnly,
  type ConfigGet,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';

export interface BudgetBreachUsageSnapshot {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface BudgetBreachNotifierDeps {
  readonly focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>;
  readonly configGet: ConfigGet;
  readonly webhookNotifier?: WebhookNotifier | null;
  readonly sessionId: string;
  /** The name of the turn that just ended (the one during which the budget tripped). */
  readonly getTurnName?: (() => string | null) | undefined;
  /** Desktop delivery; defaults to the SDK notifyCompletion. Tests pass a spy to read the text. */
  readonly notifyDesktop?: typeof notifyCompletion | undefined;
}

/** Stateful edge-trigger checker, construct once per session, call on every TURN_COMPLETED. */
export interface BudgetBreachNotifier {
  /**
   * Evaluate current usage against the configured threshold and fire an
   * alert on the false→true breach edge. Returns true when an alert was
   * fired this call (for tests / observability), false otherwise.
   */
  check(usage: BudgetBreachUsageSnapshot, sessionModel: string, budgetThresholdUsd: number): boolean;
}

export function createBudgetBreachNotifier(deps: BudgetBreachNotifierDeps): BudgetBreachNotifier {
  let lastThreshold: number | null = null;
  let notified = false;

  return {
    check(usage, sessionModel, budgetThresholdUsd) {
      if (budgetThresholdUsd !== lastThreshold) {
        // Threshold raised, lowered, or cleared since the last check, re-arm
        // the latch so a breach against the new threshold can fire again.
        lastThreshold = budgetThresholdUsd;
        notified = false;
      }

      if (budgetThresholdUsd <= 0) return false; // disabled
      if (!isModelPriced(sessionModel)) return false; // cost would be a placeholder, not real

      const sessionCost = calcSessionCost(usage.input, usage.output, usage.cacheRead, usage.cacheWrite, sessionModel);
      const breached = computeBudgetBreach(sessionCost, budgetThresholdUsd);

      if (!breached) {
        notified = false; // dropped back under budget, can re-fire on the next crossing
        return false;
      }
      if (notified) return false; // already alerted for this crossing

      notified = true;
      fireBudgetBreachAlert(deps, sessionCost, budgetThresholdUsd);
      return true;
    },
  };
}

function fireBudgetBreachAlert(deps: BudgetBreachNotifierDeps, sessionCost: number, budgetThresholdUsd: number): void {
  if (!shouldFireAlert(deps.focusTracker, deps.configGet, 'behavior.notifyOnBudgetBreach')) return;

  const metadataOnly = readNotificationsMetadataOnly(deps.configGet);
  const notice = buildBudgetNotification({
    sessionCostUsd: sessionCost,
    budgetUsd: budgetThresholdUsd,
    sessionId: deps.sessionId,
    turnName: metadataOnly ? null : deps.getTurnName?.() ?? null,
  }, { metadataOnly });

  try {
    (deps.notifyDesktop ?? notifyCompletion)(notice.title, notice.body, FORCE_NOTIFY_DURATION_MS);
  } catch (err) {
    logger.debug('budget-breach-notifier: desktop notify error', { error: String(err) });
  }

  const webhookNotifier = deps.webhookNotifier;
  if (webhookNotifier) {
    const urls = webhookNotifier.getUrls();
    if (urls.length > 0) {
      webhookNotifier.send(formatWebhookText(notice)).catch((err: unknown) => {
        logger.debug('budget-breach-notifier: webhook send error', { error: String(err) });
      });
    }
  }
}
