import type { ToolCall } from '../../types/tools.ts';
import type { TranscriptEvent } from './types.ts';
import type { ConversationMessageSnapshot } from '../conversation.ts';

function summarizeText(text: string, max = 96): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function classifySystemKind(text: string): TranscriptEvent['kind'] {
  if (text.includes('[Remote]') || text.includes('[Teleport]') || text.includes('[Bridge]')) return 'remote_status';
  if (text.includes('[WRFC]') || text.includes('[Review]')) return 'review_state';
  if (text.includes('[Policy]') || text.includes('[Security]')) return 'policy_warning';
  if (text.includes('[Health]') || text.includes('[Local]') || text.includes('[Scan]') || text.includes('[Forensics]')) return 'diagnostic_notice';
  if (text.includes('[Session]') || text.includes('[Recovery]') || text.includes('[Resume]')) return 'session_restore';
  if (text.includes('[Approval]')) {
    return /(allowed|approved|denied|rejected|granted)/i.test(text) ? 'approval_resolution' : 'approval_request';
  }
  if (text.includes('[Task]') || text.includes('[Tasks]') || text.includes('[Agent]')) return 'task_transition';
  return 'system_notice';
}

function toolCallEvents(messageIndex: number, toolCalls: readonly ToolCall[]): TranscriptEvent[] {
  return toolCalls.map((call, index) => ({
    id: `msg-${messageIndex}-tool-call-${index}`,
    kind: 'tool_call',
    messageIndex,
    groupKey: `tool:${call.id}`,
    title: call.name,
    detail: summarizeText(JSON.stringify(call.arguments ?? {})),
    relatedCallId: call.id,
  }));
}

export function classifyTranscriptMessages(messages: readonly ConversationMessageSnapshot[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  messages.forEach((message, messageIndex) => {
    switch (message.role) {
      case 'user': {
        const content = typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.type === 'text' ? part.text : '[image]').join(' ');
        events.push({
          id: `msg-${messageIndex}-user`,
          kind: 'user_input',
          messageIndex,
          groupKey: `user:${messageIndex}`,
          title: 'User input',
          detail: summarizeText(content),
        });
        break;
      }
      case 'assistant': {
        if (message.content.trim()) {
          events.push({
            id: `msg-${messageIndex}-assistant`,
            kind: 'assistant_output',
            messageIndex,
            groupKey: `assistant:${messageIndex}`,
            title: 'Assistant output',
            detail: summarizeText(message.content),
          });
        }
        if (message.toolCalls?.length) {
          events.push(...toolCallEvents(messageIndex, message.toolCalls));
        }
        break;
      }
      case 'tool':
        events.push({
          id: `msg-${messageIndex}-tool-result`,
          kind: 'tool_result',
          messageIndex,
          groupKey: `tool:${message.callId}`,
          title: message.toolName ?? 'Tool result',
          detail: summarizeText(message.content),
          relatedCallId: message.callId,
        });
        break;
      case 'system': {
        const kind = classifySystemKind(message.content);
        events.push({
          id: `msg-${messageIndex}-system`,
          kind,
          messageIndex,
          groupKey: `${kind}:${messageIndex}`,
          title: kind.replace(/_/g, ' '),
          detail: summarizeText(message.content),
        });
        break;
      }
    }
  });
  return events;
}
