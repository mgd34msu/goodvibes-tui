import type { ContentPart, ProviderMessage } from '../providers/interface.ts';
import type { ConversationMessageSnapshot } from './conversation.ts';

type Message = ConversationMessageSnapshot;

export function cloneMessages(messages: Message[]): Message[] {
  return structuredClone(messages);
}

function extractAssistantText(content: ProviderMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toInternalMessage(message: ProviderMessage): Message {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: typeof message.content === 'string' ? message.content : (message.content as ContentPart[]),
    };
  }
  if (message.role === 'assistant') {
    return { role: 'assistant', content: extractAssistantText(message.content) };
  }
  const toolMsg = message as { role: 'tool'; callId: string; content: string | unknown };
  return {
    role: 'tool',
    callId: toolMsg.callId ?? '',
    content: typeof toolMsg.content === 'string' ? toolMsg.content : String(toolMsg.content),
  };
}

export function messagesToInternal(messages: ProviderMessage[]): Message[] {
  return messages.map(toInternalMessage);
}

export function cloneBranchMap(branches: Map<string, Message[]>): Record<string, Message[]> {
  const result: Record<string, Message[]> = {};
  for (const [name, msgs] of branches) {
    result[name] = cloneMessages(msgs);
  }
  return result;
}

export function restoreBranchMap(branches?: Record<string, Message[]>): Map<string, Message[]> {
  const restored = new Map<string, Message[]>();
  if (!branches) return restored;
  for (const [name, msgs] of Object.entries(branches)) {
    restored.set(name, msgs);
  }
  return restored;
}

export function deriveConversationTitle(content: string): string {
  const text = content.trim();
  if (text.length <= 50) return text;
  let cut = text.lastIndexOf(' ', 50);
  if (cut <= 0) cut = 50;
  return text.slice(0, cut);
}

export function extractUserDisplayText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  const textParts = content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
  const imageCount = content.filter((part) => part.type === 'image').length;
  return textParts.map((part) => part.text).join('') + (imageCount > 0 ? ` [+${imageCount} image(s)]` : '');
}
