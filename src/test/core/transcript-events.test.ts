import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';

describe('transcript event index', () => {
  test('classifies tool runs and system notices into grouped transcript events', () => {
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('review the file');
    conversation.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversation.addSystemMessage('[Remote] Attached to runner pool alpha');

    const index = conversation.getTranscriptEventIndex();
    expect(index.events.some((event) => event.kind === 'user_input')).toBe(true);
    expect(index.events.some((event) => event.kind === 'tool_call' && event.relatedCallId === 'call-1')).toBe(true);
    expect(index.events.some((event) => event.kind === 'tool_result' && event.relatedCallId === 'call-1')).toBe(true);
    expect(index.events.some((event) => event.kind === 'remote_status')).toBe(true);
    expect(index.groups.some((group) => group.key === 'tool:call-1')).toBe(true);
    expect(index.events.find((event) => event.kind === 'tool_result' && event.relatedCallId === 'call-1')?.title).toBe('exec');
  });

  test('navigates to next and previous transcript event lines by kind', () => {
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('review the file');
    conversation.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversation.addSystemMessage('[Approval] Waiting for operator input');

    conversation.flushHistory();
    const nextTool = conversation.nextTranscriptEventLine(0, 'tool_result');
    const prevTool = conversation.prevTranscriptEventLine(999, 'tool_result');

    expect(nextTool).toBeGreaterThanOrEqual(0);
    expect(prevTool).toBe(nextTool);
    expect(conversation.nextTranscriptEventLine(0, 'diagnostic_notice')).toBe(-1);
  });
});
