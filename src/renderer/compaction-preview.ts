/**
 * Compaction preview and after-notice builders.
 *
 * Pre-compact: shows an honest estimate of what compaction will do
 * (message count and token estimate before → after). The SDK has no dry-run
 * API; we derive the after-estimate from the DEFAULT_COMPACTION_CONFIG
 * totalCeiling (6500 tokens) — clearly labelled as an ESTIMATE.
 *
 * Post-compact: shows a before/after notice using the CompactionEvent
 * data returned by compactMessages(), which contains the real
 * tokensBeforeEstimate and tokensAfterEstimate figures.
 *
 * Honest wording policy:
 *  - Pre-compact notice says "estimate" every time; never claims certainty.
 *  - Post-compact notice uses "~N" prefix on every token figure.
 *  - Pinned session memories that survive are mentioned by count.
 */

import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core';
import { computeContextUsage } from '../core/context-usage.ts';
import { formatQualityScoreLine } from './compaction-quality.ts';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers';
import type { CompactionQualityScore } from './compaction-quality.ts';

/**
 * Default compaction totalCeiling from context-compaction DEFAULT_COMPACTION_CONFIG.
 * Kept local so we don't take a runtime dependency on the internal config object.
 * Used only for the pre-compact ESTIMATE; the real figure comes from CompactionEvent.
 */
const COMPACTION_OUTPUT_CEILING_ESTIMATE = 6500;

export interface CompactionPreviewOptions {
  /** Messages currently in the conversation. */
  readonly messages: readonly ProviderMessage[];
  /** Context window size for the current model (0 if unknown). */
  readonly contextWindow: number;
  /** Number of session memories that will survive compaction. */
  readonly pinnedMemoryCount: number;
  /** Whether this is triggered automatically or manually. */
  readonly trigger: 'auto' | 'manual';
}

export interface CompactionAfterOptions {
  /** The CompactionEvent returned by the SDK after compaction completes. */
  readonly event: CompactionEvent;
  /** Number of session memories that survived compaction. */
  readonly pinnedMemoryCount: number;
  /**
   * Out-of-band quality-score grade for this run (W5.4/B28). Omitted or null
   * when no score was computed (e.g. the small-window compaction path, which
   * has no CompactionEvent to key a score by) — no line is rendered then.
   */
  readonly qualityScore?: CompactionQualityScore | null | undefined;
}

/**
 * Build the pre-compaction notice string.
 *
 * Returned as a plain string intended for `ctx.print()` or `systemMessageRouter`.
 * Always labelled as an estimate; uses the SDK totalCeiling as the after-estimate.
 */
export function buildCompactionPreview(opts: CompactionPreviewOptions): string {
  const { messages, contextWindow, pinnedMemoryCount, trigger } = opts;
  const msgCount = messages.length;
  const tokensBefore = estimateConversationTokens(messages as ProviderMessage[]);
  const tokensAfterEstimate = COMPACTION_OUTPUT_CEILING_ESTIMATE;

  const contextStr = contextWindow > 0
    ? ` (${Math.round(computeContextUsage(tokensBefore, contextWindow).rawRatio * 100)}% of ${fmtN(contextWindow)} context window)`
    : '';

  const pinStr = pinnedMemoryCount > 0
    ? ` ${pinnedMemoryCount} pinned session memor${pinnedMemoryCount === 1 ? 'y' : 'ies'} will be preserved.`
    : '';

  const triggerStr = trigger === 'auto' ? 'Auto-compacting' : 'Compacting';

  return (
    `[Context] ${triggerStr} conversation: ~${fmtN(tokensBefore)} tokens across ${msgCount} message${msgCount === 1 ? '' : 's'}${contextStr}.` +
    ` Estimated result: ~${fmtN(tokensAfterEstimate)} tokens (estimate — actual depends on content).` +
    (pinStr ? ` ${pinStr.trim()}` : '')
  );
}

/**
 * Build the post-compaction before/after notice string.
 *
 * Uses the real CompactionEvent figures (not estimates) for both before and
 * after token counts. The trigger field controls wording.
 */
export function buildCompactionAfterNotice(opts: CompactionAfterOptions): string {
  const { event, pinnedMemoryCount, qualityScore } = opts;
  const {
    messagesBeforeCompaction,
    messagesAfterCompaction,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    trigger,
  } = event;

  const savings = Math.max(0, tokensBeforeEstimate - tokensAfterEstimate);
  const savingsPct = tokensBeforeEstimate > 0
    ? Math.round((savings / tokensBeforeEstimate) * 100)
    : 0;

  const pinStr = pinnedMemoryCount > 0
    ? ` ${pinnedMemoryCount} pinned memor${pinnedMemoryCount === 1 ? 'y' : 'ies'} preserved.`
    : '';

  const triggerStr = trigger === 'auto' ? 'Auto-compact complete' : 'Compact complete';

  const qualityStr = qualityScore ? `\n  ${formatQualityScoreLine(qualityScore)}` : '';

  return (
    `[Context] ${triggerStr}: ${messagesBeforeCompaction} → ${messagesAfterCompaction} messages,` +
    ` ~${fmtN(tokensBeforeEstimate)} → ~${fmtN(tokensAfterEstimate)} tokens` +
    ` (saved ~${fmtN(savings)}, ${savingsPct}%).` +
    (pinStr ? ` ${pinStr.trim()}` : '') +
    qualityStr
  );
}

/** Format a number with thousands separators. */
function fmtN(n: number): string {
  return n.toLocaleString();
}

/**
 * Build the /keep command usage text (shown when no args are provided).
 *
 * Exported for testability — the shell-core handler renders this string directly.
 */
export function buildPinUsageText(): string {
  return (
    '[Pin] Usage: /keep <text>\n' +
    'Pinned entries are stored as session memories and included in the compaction handoff as pinned memories.\n' +
    'What pinning guarantees: the text survives the next compaction.\n' +
    'What pinning does NOT guarantee: recovery after process restart (session memories are in-memory only).'
  );
}

/**
 * Build the /keep command success text.
 *
 * @param id - The assigned memory ID (e.g. "mem-1")
 * @param text - The pinned text
 * @param count - Total pinned memory count after adding
 *
 * Exported for testability — the shell-core handler renders this string directly.
 */
export function buildPinSuccessText(id: string, text: string, count: number): string {
  return (
    `[Pin] Pinned as ${id}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"\n` +
    `  ${count} pinned memor${count === 1 ? 'y' : 'ies'} will survive the next compaction.\n` +
    '  Note: session memories are in-memory only and do not persist across restarts.'
  );
}
