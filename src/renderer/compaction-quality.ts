/**
 * Compaction quality-score bridging.
 *
 * Reality check: the SDK's `computeQualityScore()`
 * (platform/runtime/compaction/quality-score.ts) is only ever called from a
 * SEPARATE pipeline, `CompactionManager` (platform/runtime/compaction/manager.ts).
 * The TUI's actual `/compact` path never instantiates `CompactionManager` — it
 * goes through `platform/core/context-compaction.ts` via
 * `ConversationManager.compact()` (see `compactConversation()` in
 * runtime-services.ts), which has no scoring of its own. Adopting the whole
 * `CompactionManager` pipeline just to get the score would be a far bigger
 * change than this item calls for.
 *
 * Instead, this module calls `computeQualityScore()` directly and out-of-band,
 * fed by the before/after message sets and token estimates
 * `compactConversation()` already holds. That's enough to close the gap:
 * quality scoring reaches `/compact` and `/compact-history` without adopting
 * `CompactionManager`.
 *
 * Honesty note: the `strategy` value passed to `computeQualityScore()` is a
 * BORROWED rubric label describing what `compactConversation()`'s structured
 * multi-section extraction actually does (collapse the whole conversation
 * into one handoff message) — it is NOT a real `CompactionStrategy`
 * escalation result, and no strategy switch is triggered from it. Every
 * rendering of the score says so explicitly (see `formatQualityScoreLine`).
 *
 * Storage: scores are kept in a TUI-local, timestamp-keyed store, never added
 * to the SDK's public `CompactionEvent` type (that would force an
 * api-extractor regen for a value the SDK's own compaction log never
 * populates). Keyed by `CompactionEvent.timestamp` rather than array index,
 * because `compactSmallWindow`'s null-event path (small-context-window
 * models — see runtime-services.ts) can create index gaps.
 */

import { computeQualityScore, describeScore } from '@/runtime/index.ts';
import type { CompactionQualityScore, StrategyInput, StrategyOutput } from '@/runtime/index.ts';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers';

export type { CompactionQualityScore } from '@/runtime/index.ts';

/**
 * Bound the TUI-local score store the same way the SDK bounds its own
 * compaction event log (context-compaction.ts caps at 50 and shifts the
 * oldest entry) — a long-running session should not accumulate this forever.
 */
const MAX_TRACKED_SCORES = 50;

const scoresByTimestamp = new Map<number, CompactionQualityScore>();

/** Record a computed quality score, keyed by the CompactionEvent's timestamp. */
export function recordCompactionQualityScore(timestamp: number, score: CompactionQualityScore): void {
  scoresByTimestamp.set(timestamp, score);
  if (scoresByTimestamp.size > MAX_TRACKED_SCORES) {
    const oldestKey = scoresByTimestamp.keys().next().value;
    if (oldestKey !== undefined) scoresByTimestamp.delete(oldestKey);
  }
}

/** Look up a previously-recorded quality score for a CompactionEvent, by timestamp. */
export function getCompactionQualityScore(timestamp: number): CompactionQualityScore | undefined {
  return scoresByTimestamp.get(timestamp);
}

export interface ScoreCompactionRunInput {
  readonly sessionId: string;
  readonly contextWindow: number;
  readonly messagesBefore: readonly ProviderMessage[];
  readonly messagesAfter: readonly ProviderMessage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/**
 * Compute a CompactionQualityScore for one compaction run, out-of-band from
 * the SDK's own (unused, in this TUI) CompactionManager pipeline.
 */
export function scoreCompactionRun(input: ScoreCompactionRunInput): CompactionQualityScore {
  const strategyInput: StrategyInput = {
    sessionId: input.sessionId,
    messages: input.messagesBefore,
    tokensBefore: input.tokensBefore,
    contextWindow: input.contextWindow,
    // Borrowed rubric label, not a real strategy escalation — see module doc.
    strategy: 'collapse',
  };
  const strategyOutput: StrategyOutput = {
    messages: [...input.messagesAfter],
    tokensAfter: input.tokensAfter,
    summary: '',
    strategy: 'collapse',
    durationMs: 0,
    warnings: [],
  };
  return computeQualityScore(strategyInput, strategyOutput);
}

/** One-line grade summary for the /compact after-notice and /compact-history entries. */
export function formatQualityScoreLine(score: CompactionQualityScore): string {
  return `Quality: ${describeScore(score)} (rubric applied out-of-band; no strategy escalation ran)`;
}
