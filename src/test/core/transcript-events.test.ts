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

  test('rows hidden by a collapsed assistant turn resolve navigation to the turn header, not past it to the next message', () => {
    // Regression: a folded (non-owning) group member renders zero lines while
    // its group stays collapsed, so its messageLineRegistry entry used to be
    // left at whatever position the buffer happened to be at afterward — the
    // position the FOLLOWING message's content starts at, not this member's
    // own. 'tool_result' navigation from the group then skipped straight past
    // it into the next message instead of landing on the group.
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('read two files');           // absolute index 0
    conversation.addAssistantMessage('reading both now', {   // absolute index 1
      toolCalls: [
        { id: 'call-1', name: 'Read', arguments: { path: 'a.ts' } },
        { id: 'call-2', name: 'Read', arguments: { path: 'b.ts' } },
      ],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([                             // absolute indexes 2, 3
      { callId: 'call-1', success: true, output: 'contents of a.ts' },
      { callId: 'call-2', success: true, output: 'contents of b.ts' },
    ]);
    conversation.addUserMessage('thanks, that is all');       // absolute index 4

    conversation.flushHistory();
    // Turns default EXPANDED; collapse it to create the hidden-row condition.
    conversation.setCollapsed('turn_1', true);
    conversation.flushHistory();

    const groupBlock = conversation.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(groupBlock).toBeDefined();
    const trailingUserLine = conversation.getMessageLine(4);
    expect(trailingUserLine).not.toBe(groupBlock!.startLine);

    // Both tool-result events resolve to the SAME turn header line while the
    // turn is collapsed — neither skips ahead to the trailing user message.
    const first = conversation.nextTranscriptEventLine(-1, 'tool_result');
    expect(first).toBe(groupBlock!.startLine);
    const second = conversation.nextTranscriptEventLine(first, 'tool_result');
    expect(second).toBe(groupBlock!.startLine);
    expect(second).not.toBe(trailingUserLine);
  });
});
