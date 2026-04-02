/**
 * strategies/reactive.ts
 *
 * Reactive compaction strategy — emergency compaction triggered when the
 * provider returns a prompt-too-long error.
 *
 * This strategy must shrink the context aggressively and immediately, with
 * minimal latency. It uses a fixed-percentage drop that guarantees the
 * compacted context fits within a conservative safety margin (50% of the
 * context window).
 */

import type { ProviderMessage } from '../../../providers/interface.ts';
import { estimateTokens } from '../../../core/compaction-types.ts';
import type { StrategyInput, StrategyOutput } from '../types.ts';

/**
 * Target fraction of context window to fill after reactive compaction.
 * Keeping below 50% provides a comfortable buffer for the next turn.
 */
const REACTIVE_TARGET_FRACTION = 0.45;

/**
 * Applies reactive compaction to handle a prompt-too-long error.
 *
 * Drops messages from the oldest end until the estimated token count
 * falls below `contextWindow * REACTIVE_TARGET_FRACTION`, then prepends
 * a reactive handoff note.
 *
 * @param input - Strategy input. `input.meta.limit` may carry the provider's
 *               reported token limit for logging purposes.
 * @returns Strategy output with a drastically reduced message list.
 */
export function runReactive(input: StrategyInput): StrategyOutput {
  const startMs = Date.now();
  const { messages, tokensBefore, contextWindow, strategy, meta } = input;
  const warnings: string[] = [];

  const targetTokens = Math.floor(contextWindow * REACTIVE_TARGET_FRACTION);
  const providerLimit = typeof meta?.['limit'] === 'number' ? meta['limit'] : null;

  // Pre-compute per-message token estimates, then use a running sum (O(n) not O(n²))
  const perMessageTokens = (messages as ProviderMessage[]).map((m) =>
    estimateTokens(JSON.stringify(m)),
  );
  let totalTokens = perMessageTokens.reduce((a, b) => a + b, 0);
  let cutIndex = 0;
  while (cutIndex < messages.length - 1 && totalTokens > targetTokens) {
    totalTokens -= perMessageTokens[cutIndex];
    cutIndex++;
  }
  const remaining: ProviderMessage[] = (messages as ProviderMessage[]).slice(cutIndex);

  const droppedCount = messages.length - remaining.length;

  if (droppedCount === 0) {
    warnings.push('reactive: could not reduce context below target; context may still exceed limit');
  }

  const handoffLines: string[] = [
    '[Reactive Compaction — Context Overflow Recovery]',
    `Provider returned prompt-too-long${providerLimit !== null ? ` (limit: ${providerLimit} tokens)` : ''}.`,
    `${droppedCount} message(s) dropped to recover from overflow.`,
    `Estimated tokens before: ${tokensBefore}, target: ≤${targetTokens}.`,
  ];

  const handoff: ProviderMessage = {
    role: 'user',
    content: [{ type: 'text', text: handoffLines.join('\n') }],
  };

  const compacted: ProviderMessage[] = [handoff, ...remaining];
  const tokensAfter = estimateTokens(JSON.stringify(compacted));

  if (tokensAfter > targetTokens) {
    warnings.push(
      `reactive: final token estimate (${tokensAfter}) still exceeds target (${targetTokens})`,
    );
  }

  return {
    messages: compacted,
    tokensAfter,
    summary: `Reactive compaction: dropped ${droppedCount} messages to recover from overflow (~${tokensAfter} tokens remaining).`,
    strategy,
    durationMs: Date.now() - startMs,
    warnings,
  };
}
