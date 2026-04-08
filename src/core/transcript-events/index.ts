import { classifyTranscriptMessages } from './classify.ts';
import { groupTranscriptEvents } from './grouping.ts';
import type { ConversationMessageSnapshot } from '../conversation.ts';

export { classifyTranscriptMessages } from './classify.ts';
export { groupTranscriptEvents } from './grouping.ts';
export type { TranscriptEvent, TranscriptEventKind } from './types.ts';
export type { TranscriptEventGroup } from './grouping.ts';

export function buildTranscriptEventIndex(messages: readonly ConversationMessageSnapshot[]) {
  const events = classifyTranscriptMessages(messages);
  const groups = groupTranscriptEvents(events);
  return { events, groups };
}

