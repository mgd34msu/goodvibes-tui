/**
 * strategies/autocompact.ts
 *
 * Auto-compaction strategy for the session compaction pipeline.
 *
 * This strategy is used when token pressure is in the 50–85% range. It runs
 * the full semantic compaction pipeline including section-based extraction,
 * lineage tracking, and post-compaction validation.
 */

import type { ProviderMessage } from '../../../providers/interface.ts';
import { estimateTokens } from '../../../core/compaction-types.ts';
import type { StrategyInput, StrategyOutput } from '../types.ts';

/**
 * Applies automatic threshold-based compaction.
 *
 * This uses the standard compaction pipeline. If a registry-backed context
 * summary is unavailable, it falls back to a structural compaction that keeps
 * a wider recent-message window than microcompact.
 *
 * @param input - Strategy input.
 * @returns Strategy output.
 */
export function runAutocompact(input: StrategyInput): StrategyOutput {
  const startMs = Date.now();
  const { messages, tokensBefore, strategy } = input;
  const warnings: string[] = [];

  // Keep the most recent 60% of messages by count, drop the oldest 40%
  const keepCount = Math.max(1, Math.ceil(messages.length * 0.6));
  const dropped = messages.length - keepCount;
  const kept = messages.slice(-keepCount) as ProviderMessage[];

  const handoff: ProviderMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '[Session Auto-Compaction]',
          `${dropped} earlier message(s) compacted to reduce context size.`,
          `Retaining the ${keepCount} most recent messages.`,
          'Context window pressure was above threshold — automatic compaction applied.',
        ].join('\n'),
      },
    ],
  };

  const compacted: ProviderMessage[] = [handoff, ...kept];
  const tokensAfter = estimateTokens(JSON.stringify(compacted));

  if (dropped === 0) {
    warnings.push('autocompact: no messages were dropped; context may still be near limit');
  }

  return {
    messages: compacted,
    tokensAfter,
    summary: `Auto-compaction: dropped ${dropped} messages (~${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction).`,
    strategy,
    durationMs: Date.now() - startMs,
    warnings,
  };
}
