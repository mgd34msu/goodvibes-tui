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
import { getLastCompactionEvent } from '@pellux/goodvibes-sdk/platform/core';
import type { CompactionContext } from '@pellux/goodvibes-sdk/platform/core';
import { buildCompactionPreview, buildCompactionAfterNotice } from '../renderer/compaction-preview.ts';
import { computeContextUsage } from './context-usage.ts';

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

  const { pct: usagePct } = computeContextUsage(deps.lastInputTokens, deps.contextWindow);
  if (usagePct < thresholdPct) return;

  try {
    logger.debug('auto-compact triggered', { usagePct, thresholdPct });
    // Pre-compact preview — uses buildCompactionPreview for an honest estimate.
    const messages = deps.conversation.getMessagesForLLM();
    const sessionMemoryStore = deps.conversation.getSessionMemoryStore();
    const sessionMemories = sessionMemoryStore?.list() ?? [];
    const pinnedMemoryCount = sessionMemories.length;
    const preview = buildCompactionPreview({
      messages,
      contextWindow: deps.contextWindow,
      pinnedMemoryCount,
      trigger: 'auto',
    });
    deps.systemMessageRouter.routeSystemMessage(preview, 'high');
    const eventBefore = getLastCompactionEvent();
    // Lineage counters live on the conversation's own tracker (typed narrowly on
    // the SDK base — widen to read them). agents/wrfcChains/activePlan stay empty:
    // the interactive TUI compacts the main conversation only and does not fold
    // sub-agent/plan state into the handoff summary.
    const lineage = deps.conversation.getSessionLineageTracker?.() as unknown as {
      getCompactionCount?(): number;
      getEntries?(): string[];
    } | undefined;
    const compactionCtx: CompactionContext = {
      messages,
      sessionMemories,
      agents: [],
      wrfcChains: [],
      activePlan: null,
      lineageEntries: lineage?.getEntries?.() ?? [],
      compactionCount: lineage?.getCompactionCount?.() ?? 0,
      contextWindow: deps.contextWindow,
      trigger: 'auto',
      extractionModelId: deps.model,
      extractionProvider: deps.provider,
    };
    await deps.conversation.compact(
      deps.providerRegistry,
      deps.model,
      'auto',
      deps.provider,
      compactionCtx,
    );
    // Post-compact notice using real CompactionEvent figures.
    const eventAfter = getLastCompactionEvent();
    if (eventAfter !== null && eventAfter !== eventBefore) {
      deps.systemMessageRouter.routeSystemMessage(
        buildCompactionAfterNotice({ event: eventAfter, pinnedMemoryCount }),
        'low',
      );
    } else {
      deps.systemMessageRouter.routeSystemMessage(
        '[Context] Auto-compact complete — older turns summarised. Use /compact to compact again manually.',
        'low',
      );
    }
  } catch (err) {
    logger.error('auto-compact failed', { error: summarizeError(err) });
    deps.systemMessageRouter.routeSystemMessage(
      `[Context] Auto-compact failed: ${summarizeError(err)}. Use /compact to try manually.`,
      'high',
    );
  }
}
