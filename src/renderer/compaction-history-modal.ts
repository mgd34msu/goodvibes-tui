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
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';

// ─── formatCompactionEvent ────────────────────────────────────────────────────

function formatCompactionEvent(ev: CompactionEvent, n: number): string {
  const date = new Date(ev.timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const savings = Math.max(0, ev.tokensBeforeEstimate - ev.tokensAfterEstimate);
  const savingsPct = ev.tokensBeforeEstimate > 0
    ? Math.round((savings / ev.tokensBeforeEstimate) * 100)
    : 0;
  const trigger = ev.trigger === 'auto' ? 'auto' : 'manual';
  return (
    `#${n} ${timeStr} [${trigger}]  ` +
    `${ev.messagesBeforeCompaction}→${ev.messagesAfterCompaction} msgs  ` +
    `~${fmtN(ev.tokensBeforeEstimate)}→~${fmtN(ev.tokensAfterEstimate)} tok  ` +
    `saved ${savingsPct}%`
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
    lines.push('  ' + formatCompactionEvent(ordered[i], ordered.length - i));
  }
  lines.push('  (Restore not available — the SDK does not yet expose a snapshot restore API.)');
  return lines.join('\n');
}
