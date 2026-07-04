/**
 * Compaction history text builder.
 *
 * Renders a read-only list of past compaction events sourced from the SDK's
 * module-level compaction event log (`getCompactionEvents()`).
 *
 * The SDK records CompactionEvent data (timestamps, token counts,
 * trigger, message counts) but does not expose a snapshot restore API.
 * Restore is list-only; users can view what compactions ran but cannot roll back.
 */

import { getCompactionEvents } from '@pellux/goodvibes-sdk/platform/core';
import { getCompactionQualityScore } from './compaction-quality.ts';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';
import type { CompactionQualityScore } from './compaction-quality.ts';

// ─── formatCompactionEvent ────────────────────────────────────────────────────

/**
 * Exported for direct unit testing (W5.4/B28) — the grade suffix is a pure
 * function of the event and an optional score, independent of whichever
 * runtime lookup (getCompactionQualityScore) supplies that score.
 */
export function formatCompactionEvent(
  ev: CompactionEvent,
  n: number,
  qualityScore?: CompactionQualityScore | null,
): string {
  const date = new Date(ev.timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const savings = Math.max(0, ev.tokensBeforeEstimate - ev.tokensAfterEstimate);
  const savingsPct = ev.tokensBeforeEstimate > 0
    ? Math.round((savings / ev.tokensBeforeEstimate) * 100)
    : 0;
  const trigger = ev.trigger === 'auto' ? 'auto' : 'manual';
  // Honest omission: no score means none was computed for this event (e.g. it
  // pre-dates this feature, or ran through the small-window path, which has
  // no CompactionEvent to key a score by) — never fabricate a grade.
  const qualityStr = qualityScore ? `  quality=${qualityScore.grade} (${qualityScore.score.toFixed(2)})` : '';
  return (
    `#${n} ${timeStr} [${trigger}]  ` +
    `${ev.messagesBeforeCompaction}→${ev.messagesAfterCompaction} msgs  ` +
    `~${fmtN(ev.tokensBeforeEstimate)}→~${fmtN(ev.tokensAfterEstimate)} tok  ` +
    `saved ${savingsPct}%${qualityStr}`
  );
}

function fmtN(n: number): string {
  return n.toLocaleString();
}

/**
 * Build a plain-text compaction history summary suitable for ctx.print().
 * Useful as the output of /compact-history when not in overlay mode.
 */
export function buildCompactionHistoryText(): string {
  const events = getCompactionEvents();
  if (events.length === 0) {
    return '[Context] No compactions recorded this session. (Restore is not available — the SDK does not yet expose a snapshot restore API.)';
  }
  const lines: string[] = [
    `[Context] Compaction history (${events.length} total, most recent first):`,
  ];
  const ordered = [...events].reverse();
  for (let i = 0; i < ordered.length; i++) {
    const ev = ordered[i]!;
    lines.push('  ' + formatCompactionEvent(ev, ordered.length - i, getCompactionQualityScore(ev.timestamp)));
  }
  lines.push('  (Restore not available — the SDK does not yet expose a snapshot restore API.)');
  return lines.join('\n');
}
