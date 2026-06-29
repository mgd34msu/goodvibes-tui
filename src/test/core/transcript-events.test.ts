import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

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

  test('messageLineRegistry uses absolute index — transcript navigation works after clearDisplay', () => {
    // Regression for finding #4: with the bug, messageLineRegistry was keyed by
    // slice-relative index (msgIdx) but read by absolute index (event.messageIndex),
    // so nextTranscriptEventLine returned -1 after /clear.
    const conversation = new ConversationManager(() => 100);

    // Add pre-clear messages (absolute indices 0, 1, 2).
    conversation.addUserMessage('pre-clear user');
    conversation.addAssistantMessage('pre-clear reply', {
      toolCalls: [{ id: 'pre-call', name: 'ls', arguments: {} }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'pre-call', success: true, output: 'file.txt' }]);

    // Simulate /clear: renders only messages added after this point.
    conversation.clearDisplay();

    // Add post-clear messages (absolute indices 3, 4, 5).
    conversation.addUserMessage('post-clear user');
    conversation.addAssistantMessage('post-clear reply', {
      toolCalls: [{ id: 'post-call', name: 'grep', arguments: { q: 'hello' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'post-call', success: true, output: 'match' }]);

    // Render — this is where the registry gets populated.
    conversation.flushHistory();

    // With the bug: messageLineRegistry[3..5] are undefined → navigation returns -1.
    // With the fix: messageLineRegistry[3..5] hold the rendered line numbers.
    const nextLine = conversation.nextTranscriptEventLine(0, 'tool_result');
    expect(nextLine).toBeGreaterThanOrEqual(0);
    const prevLine = conversation.prevTranscriptEventLine(9999, 'tool_result');
    expect(prevLine).toBe(nextLine);
  });
});
