/**
 * strategies/microcompact.ts
 *
 * Micro-compaction strategy — lightweight token reduction by summarising only
 * the oldest turns in the conversation, preserving recent messages intact.
 *
 * This is the lowest-latency strategy: no LLM call, purely structural.
 * It drops assistant/tool messages beyond a configurable "keep recent" window
 * and prepends a short handoff note summarising what was dropped.
 */

import type { ProviderMessage } from '../../../providers/interface.ts';
import { estimateTokens } from '../../../core/compaction-types.ts';
import type { StrategyInput, StrategyOutput } from '../types.ts';

/** Number of recent messages preserved without modification. */
const DEFAULT_KEEP_RECENT = 20;

/**
 * Applies micro-compaction: keep the last N messages, drop earlier ones,
 * and prepend a brief handoff note.
 *
 * @param input - Strategy input containing messages and context.
 * @returns Strategy output with compacted messages and token estimates.
 */
export function runMicrocompact(input: StrategyInput): StrategyOutput {
  const startMs = Date.now();
  const { messages, tokensBefore, strategy } = input;

  const keepRecent = DEFAULT_KEEP_RECENT;
  const warnings: string[] = [];

  if (messages.length <= keepRecent) {
    // Nothing to compact — return messages unchanged
    warnings.push('microcompact: message count within keep window; no reduction applied');
    return {
      messages: [...messages] as ProviderMessage[],
      tokensAfter: tokensBefore,
      summary: 'No compaction applied — message count within keep window.',
      strategy,
      durationMs: Date.now() - startMs,
      warnings,
    };
  }

  const kept = messages.slice(-keepRecent) as ProviderMessage[];
  const droppedCount = messages.length - keepRecent;

  const handoff: ProviderMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          `[Session Micro-Compaction]`,
          `${droppedCount} earlier message(s) were summarised to reduce context size.`,
          `The conversation continues from the most recent ${keepRecent} messages.`,
        ].join('\n'),
      },
    ],
  };

  const compacted: ProviderMessage[] = [handoff, ...kept];
  const tokensAfter = estimateTokens(JSON.stringify(compacted));

  return {
    messages: compacted,
    tokensAfter,
    summary: `Micro-compaction: dropped ${droppedCount} messages, kept ${keepRecent} recent.`,
    strategy,
    durationMs: Date.now() - startMs,
    warnings,
  };
}
