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
 * never be reported as a real breach (mirrors CostTrackerPanel's "unpriced"
 * display convention).
 *
 * PRIVACY: message text is built from cost/threshold numbers and the
 * session id prefix only, no conversation content.
 */
import { notifyCompletion } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { calcSessionCost, computeBudgetBreach, isModelPriced } from '@pellux/goodvibes-sdk/platform/providers';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { shouldFireAlert, FORCE_NOTIFY_DURATION_MS, type ConfigGet } from '@pellux/goodvibes-sdk/platform/runtime/operations';

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

  const title = 'GoodVibes: budget breach';
  const message = `session cost $${sessionCost.toFixed(2)} exceeded budget $${budgetThresholdUsd.toFixed(2)}  ·  session ${deps.sessionId.slice(0, 8)}`;

  try {
    notifyCompletion(title, message, FORCE_NOTIFY_DURATION_MS);
  } catch (err) {
    logger.debug('budget-breach-notifier: desktop notify error', { error: String(err) });
  }

  const webhookNotifier = deps.webhookNotifier;
  if (webhookNotifier) {
    const urls = webhookNotifier.getUrls();
    if (urls.length > 0) {
      webhookNotifier.send(message).catch((err: unknown) => {
        logger.debug('budget-breach-notifier: webhook send error', { error: String(err) });
      });
    }
  }
}
