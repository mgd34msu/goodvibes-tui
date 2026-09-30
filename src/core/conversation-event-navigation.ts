/**
 * conversation-event-navigation.ts, resolving "jump to the next/previous
 * transcript event" into a history-buffer line number.
 *
 * Extracted from ConversationManager (core/conversation.ts), which is at its
 * line-count gate, and kept structural (no SDK imports beyond the event kind)
 * so the ordering rule can be tested without building a conversation.
 *
 * The rule both directions share: take the events of the requested kind, map
 * each to the line its message was rendered at, drop the ones that were never
 * rendered (a message with no registry entry), sort ascending, then wrap,
 * searching forward past `currentLine` falls back to the first line, searching
 * backward falls back to the last. -1 means there is nowhere to go.
 */

import type { TranscriptEventKind } from '@pellux/goodvibes-sdk/platform/core';

/** The subset of a transcript-event-index entry this module reads. */
export interface TranscriptEventLike {
  readonly kind: TranscriptEventKind;
  readonly messageIndex: number;
}

export function resolveTranscriptEventLine(
  events: readonly TranscriptEventLike[],
  kind: TranscriptEventKind | 'all',
  messageLineRegistry: readonly (number | undefined)[],
  currentLine: number,
  direction: 'next' | 'prev',
): number {
  const selected = kind === 'all' ? events : events.filter((event) => event.kind === kind);
  if (selected.length === 0) return -1;
  const lines = selected
    .map((event) => messageLineRegistry[event.messageIndex] ?? -1)
    .filter((line) => line >= 0)
    .sort((a, b) => a - b);
  if (lines.length === 0) return -1;
  if (direction === 'next') {
    return lines.find((line) => line > currentLine) ?? lines[0]!;
  }
  return [...lines].reverse().find((line) => line < currentLine) ?? lines[lines.length - 1]!;
}

/** The next (or previous) line in a sorted list after (or before) `currentLine`, wrapping around; -1 when the list is empty. */
export function wrapToLine(lines: readonly number[], currentLine: number, direction: 'next' | 'prev'): number {
  if (lines.length === 0) return -1;
  if (direction === 'next') return lines.find((line) => line > currentLine) ?? lines[0]!;
  return [...lines].reverse().find((line) => line < currentLine) ?? lines[lines.length - 1]!;
}

/** The block containing `lineIndex`, else the one starting nearest it (optionally only blocks of `typeFilter`). */
export function nearestBlock<B extends { readonly type: string; readonly startLine: number; readonly lineCount: number }>(
  blocks: readonly B[],
  lineIndex: number,
  typeFilter?: string,
): B | null {
  let nearest: B | null = null;
  let nearestDist = Infinity;
  for (const block of blocks) {
    if (typeFilter !== undefined && block.type !== typeFilter) continue;
    if (lineIndex >= block.startLine && lineIndex < block.startLine + block.lineCount) return block;
    const dist = Math.abs(block.startLine - lineIndex);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = block;
    }
  }
  return nearest;
}
