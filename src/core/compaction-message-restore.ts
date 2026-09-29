/**
 * compaction-message-restore.ts, keeping kept messages whole across a compaction.
 *
 * A compaction hands the conversation a list of provider-shaped messages to
 * keep (small-window mode keeps the last N of getMessagesForLLM() as they
 * are). The SDK's replaceMessagesForLLM turns those back into transcript
 * messages with messagesToInternal, which keeps only role and text for an
 * assistant message: its tool calls, model, reasoning and usage are dropped.
 * The transcript then shows every kept tool result as a call-less orphan bead
 * (no argument, no summary from the call), the turn header loses its model,
 * and the next request carries tool results with no call before them.
 *
 * This maps each kept provider message back to the transcript message it was
 * built from (getMessagesForLLM() builds one provider message per non-system
 * message, in order, and compaction keeps those very objects), so a kept
 * message comes back exactly as it was. A message compaction wrote itself
 * (the summary pair) or one that cannot be matched keeps the SDK's
 * conversion, with the provider message's tool calls put back.
 */

import type { ConversationMessageSnapshot, ConversationTitleSource } from '@pellux/goodvibes-sdk/platform/core';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers';

type Message = ConversationMessageSnapshot;

/**
 * Pair each provider message with the transcript message it came from. Empty
 * when the two lists do not line up (the conversation changed in between).
 */
export function providerMessageSources(llm: readonly ProviderMessage[], full: readonly Message[]): Map<ProviderMessage, Message> {
  const sources = new Map<ProviderMessage, Message>();
  const nonSystem = full.filter((m) => m.role !== 'system');
  if (nonSystem.length !== llm.length) return sources;
  for (let i = 0; i < llm.length; i++) {
    if (llm[i]!.role !== nonSystem[i]!.role) return new Map();
    sources.set(llm[i]!, nonSystem[i]!);
  }
  return sources;
}

/**
 * The transcript after a compaction, with every kept message whole.
 *
 * @param converted   the SDK's result: system messages first, then one
 *                    converted message per entry of `kept`, in order.
 * @param kept        what the compaction asked the conversation to keep.
 * @param sources     providerMessageSources() taken before the replace.
 */
export function restoreCompactedMessages(
  converted: readonly Message[],
  kept: readonly ProviderMessage[],
  sources: ReadonlyMap<ProviderMessage, Message>,
): Message[] {
  const systemCount = converted.length - kept.length;
  if (systemCount < 0) return [...converted];
  const out: Message[] = converted.slice(0, systemCount);
  for (let i = 0; i < kept.length; i++) {
    const provider = kept[i]!;
    const original = sources.get(provider);
    if (original) { out.push(structuredClone(original)); continue; }
    const message = converted[systemCount + i]!;
    const calls = provider.role === 'assistant' ? provider.toolCalls : undefined;
    if (message.role === 'assistant' && calls && calls.length > 0 && !(message.toolCalls?.length)) {
      out.push({ ...message, toolCalls: structuredClone(calls) });
    } else {
      out.push(message);
    }
  }
  return out;
}

/** What replaceKeepingMessagesWhole reads from the conversation. */
export interface ReplaceHost {
  toJSON(): unknown;
  getMessagesForLLM(): readonly ProviderMessage[];
  readonly title: string;
  getTitleSource(): ConversationTitleSource;
}

/** The persisted shape fromJSON takes back. */
export interface RestoredConversation {
  messages: Message[];
  branches?: Record<string, Message[]>;
  currentBranch?: string;
  title: string;
  titleSource: ConversationTitleSource;
}

/**
 * Run the SDK's replace (`replace`), then put every kept message back whole
 * through the SDK's restore (`restore`), keeping branches and title.
 */
export function replaceKeepingMessagesWhole(
  host: ReplaceHost,
  kept: readonly ProviderMessage[],
  replace: (kept: ProviderMessage[]) => void,
  restore: (data: RestoredConversation) => void,
): void {
  const before = host.toJSON() as { messages: Message[] };
  const sources = providerMessageSources(host.getMessagesForLLM(), before.messages);
  replace([...kept]);
  const after = host.toJSON() as { messages: Message[]; branches?: Record<string, Message[]>; currentBranch?: string };
  restore({
    messages: restoreCompactedMessages(after.messages, kept, sources),
    branches: after.branches,
    currentBranch: after.currentBranch,
    title: host.title,
    titleSource: host.getTitleSource(),
  });
}
