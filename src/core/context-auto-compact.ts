/**
 * Auto-compaction helper — TASK-058.
 *
 * Evaluates whether auto-compact should run after a turn completes and, if so,
 * triggers compaction and posts an honest transcript notice.
 *
 * behavior.autoCompactThreshold: SDK schema range [10, 100], default 80.
 * Auto-compact is active whenever the threshold is in its valid range (>0).
 * The display/suggestion path (hint + meter) is always active regardless.
 */

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConversationManager } from './conversation';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { SystemMessageRouter } from './system-message-router';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export interface AutoCompactDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly conversation: ConversationManager;
  readonly providerRegistry: ProviderRegistry;
  readonly systemMessageRouter: SystemMessageRouter;
  readonly model: string;
  readonly provider: string;
  readonly lastInputTokens: number;
  readonly contextWindow: number;
}

/**
 * Run after each TURN_COMPLETED event.
 *
 * Reads behavior.autoCompactThreshold from config (SDK default: 80, range [10, 100]).
 * When usage is at or above the threshold, compacts the conversation and posts
 * an honest transcript notice so the user understands any summary discontinuity.
 *
 * This function is intentionally non-throwing; failures are logged and
 * surfaced via the system message router.
 */
export async function maybeAutoCompact(deps: AutoCompactDeps): Promise<void> {
  // SDK schema default is 80; valid range is [10, 100]. The ?? 0 fallback is a
  // defensive guard for missing/null values only — not a normal operating state.
  const rawThreshold = Number(deps.configManager.get('behavior.autoCompactThreshold') ?? 0);
  const thresholdPct = Number.isFinite(rawThreshold) ? rawThreshold : 0;

  // Defensive guard: skip only when threshold is missing/non-positive (real config defaults to 80).
  if (thresholdPct <= 0 || deps.contextWindow <= 0) return;

  const usagePct = Math.min(100, Math.round((Math.max(0, deps.lastInputTokens) / deps.contextWindow) * 100));
  if (usagePct < thresholdPct) return;

  try {
    logger.debug('auto-compact triggered', { usagePct, thresholdPct });
    // Honest transcript notice — the user should always know when compaction
    // runs automatically so they can understand any summary discontinuity.
    deps.systemMessageRouter.routeSystemMessage(
      `[Context] Auto-compacting conversation — usage reached ${usagePct}% (threshold ${thresholdPct}%). A summary will replace older turns to recover headroom.`,
      'high',
    );
    await deps.conversation.compact(
      deps.providerRegistry,
      deps.model,
      'auto',
      deps.provider,
    );
    deps.systemMessageRouter.routeSystemMessage(
      `[Context] Auto-compact complete — older turns summarised. Use /compact to compact again manually.`,
      'low',
    );
  } catch (err) {
    logger.error('auto-compact failed', { error: summarizeError(err) });
    deps.systemMessageRouter.routeSystemMessage(
      `[Context] Auto-compact failed: ${summarizeError(err)}. Use /compact to try manually.`,
      'high',
    );
  }
}
