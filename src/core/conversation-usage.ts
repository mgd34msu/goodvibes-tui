/**
 * conversation-usage.ts, usage totals folded from a transcript's assistant
 * messages (re-exported by conversation.ts).
 */

import type { ConversationMessageSnapshot, OrchestratorUsageTotals } from '@pellux/goodvibes-sdk/platform/core';

/**
 * sumConversationUsage - Fold every assistant message's per-turn usage into
 * running totals, plus the *last* assistant message's own input-token figure
 * (context-window occupancy, not a running sum).
 *
 * TUI-side counterpart to SDK Orchestrator.usage: after a session resume
 * replays historical messages into a freshly-constructed Orchestrator (whose
 * `usage` starts at all zeros, bootstrap.ts always constructs a fresh
 * instance, see), this lets the caller hydrate the footer's token
 * counters from messages that already carry real usage data instead of
 * waiting for the first new turn to populate them.
 */
export function sumConversationUsage(
  messages: readonly ConversationMessageSnapshot[],
): { usage: OrchestratorUsageTotals; lastInputTokens: number } {
  const usage: OrchestratorUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastInputTokens = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    usage.input += message.usage.inputTokens;
    usage.output += message.usage.outputTokens;
    usage.cacheRead += message.usage.cacheReadTokens ?? 0;
    usage.cacheWrite += message.usage.cacheWriteTokens ?? 0;
    // Context-window occupancy tracks the most recent turn only, not a sum.
    lastInputTokens = message.usage.inputTokens
      + (message.usage.cacheReadTokens ?? 0)
      + (message.usage.cacheWriteTokens ?? 0);
  }
  return { usage, lastInputTokens };
}
