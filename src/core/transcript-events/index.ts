import { classifyTranscriptMessages } from './classify.ts';
import { groupTranscriptEvents } from '@pellux/goodvibes-sdk/platform/core/transcript-events/grouping';
import type { ConversationMessageSnapshot } from '../conversation.ts';

export { classifyTranscriptMessages } from './classify.ts';
export { groupTranscriptEvents } from '@pellux/goodvibes-sdk/platform/core/transcript-events/grouping';
export type { TranscriptEvent, TranscriptEventKind } from '@pellux/goodvibes-sdk/platform/core/transcript-events/types';
export type { TranscriptEventGroup } from '@pellux/goodvibes-sdk/platform/core/transcript-events/grouping';

export function buildTranscriptEventIndex(messages: readonly ConversationMessageSnapshot[]) {
  const events = classifyTranscriptMessages(messages);
  const groups = groupTranscriptEvents(events);
  return { events, groups };
}

