import type { TranscriptEvent } from './types.ts';

export interface TranscriptEventGroup {
  readonly key: string;
  readonly kind: TranscriptEvent['kind'];
  readonly title: string;
  readonly messageIndexes: readonly number[];
  readonly events: readonly TranscriptEvent[];
}

export function groupTranscriptEvents(events: readonly TranscriptEvent[]): TranscriptEventGroup[] {
  const groups = new Map<string, TranscriptEvent[]>();
  for (const event of events) {
    const existing = groups.get(event.groupKey);
    if (existing) existing.push(event);
    else groups.set(event.groupKey, [event]);
  }
  return Array.from(groups.entries()).map(([key, grouped]) => ({
    key,
    kind: grouped[0]?.kind ?? 'system_notice',
    title: grouped[0]?.title ?? key,
    messageIndexes: grouped.map((event) => event.messageIndex),
    events: grouped,
  }));
}

