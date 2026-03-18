import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';

// ConversationManager has renderer dependencies for display;
// we test the LLM message interface and state management which are renderer-independent.

describe('ConversationManager', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    // Fixed width avoids terminal dependency
    cm = new ConversationManager(() => 80);
  });

  describe('message accumulation', () => {
    test('starts with empty LLM messages', () => {
      expect(cm.getMessagesForLLM()).toEqual([]);
    });

    test('addUserMessage adds a user message', () => {
      cm.addUserMessage('hello');
      const msgs = cm.getMessagesForLLM();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello' });
    });

    test('addAssistantMessage adds an assistant message', () => {
      cm.addAssistantMessage('hi there');
      const msgs = cm.getMessagesForLLM();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ role: 'assistant', content: 'hi there' });
    });

    test('addAssistantMessage with tool calls includes them', () => {
      const toolCalls = [{ id: 'c1', name: 'file_read', arguments: { path: 'foo.ts' } }];
      cm.addAssistantMessage('calling tool', { toolCalls });
      const msgs = cm.getMessagesForLLM();
      expect(msgs[0]).toMatchObject({ role: 'assistant', toolCalls });
    });

    test('addToolResults adds tool result messages', () => {
      cm.addToolResults([{ callId: 'c1', success: true, output: 'file content' }]);
      const msgs = cm.getMessagesForLLM();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ role: 'tool', callId: 'c1', content: 'file content' });
    });

    test('addToolResults with failure includes error message', () => {
      cm.addToolResults([{ callId: 'c2', success: false, error: 'permission denied' }]);
      const msgs = cm.getMessagesForLLM();
      expect(msgs[0]).toMatchObject({ role: 'tool', callId: 'c2' });
      expect((msgs[0] as { content: string }).content).toContain('Error: permission denied');
    });

    test('addToolResults with no output uses default message', () => {
      cm.addToolResults([{ callId: 'c3', success: true }]);
      const msgs = cm.getMessagesForLLM();
      expect((msgs[0] as { content: string }).content).toBe('Tool completed successfully.');
    });

    test('system messages are excluded from LLM messages', () => {
      cm.addSystemMessage('internal info');
      expect(cm.getMessagesForLLM()).toEqual([]);
    });

    test('message order is preserved', () => {
      cm.addUserMessage('question');
      cm.addAssistantMessage('calling', { toolCalls: [{ id: 'c1', name: 'tool', arguments: {} }] });
      cm.addToolResults([{ callId: 'c1', success: true, output: 'result' }]);
      cm.addAssistantMessage('final answer');

      const msgs = cm.getMessagesForLLM();
      expect(msgs[0].role).toBe('user');
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[2].role).toBe('tool');
      expect(msgs[3].role).toBe('assistant');
    });
  });

  describe('resetAll', () => {
    test('resets all messages', () => {
      cm.addUserMessage('test');
      cm.addAssistantMessage('response');
      cm.resetAll();
      expect(cm.getMessagesForLLM()).toEqual([]);
    });
  });

  describe('toJSON / fromJSON', () => {
    test('toJSON returns serializable object with messages', () => {
      cm.addUserMessage('hi');
      const json = cm.toJSON() as { messages: unknown[]; timestamp: number };
      expect(json.messages).toHaveLength(1);
      expect(typeof json.timestamp).toBe('number');
    });

    test('fromJSON restores messages', () => {
      cm.addUserMessage('original');
      const json = cm.toJSON() as { messages: Array<{ role: string; content: string }> };

      const cm2 = new ConversationManager(() => 80);
      cm2.fromJSON(json as { messages: never[] });
      expect(cm2.getMessagesForLLM()).toHaveLength(1);
      expect(cm2.getMessagesForLLM()[0]).toMatchObject({ role: 'user', content: 'original' });
    });

    test('fromJSON with empty messages array produces empty conversation', () => {
      cm.fromJSON({ messages: [] });
      expect(cm.getMessagesForLLM()).toEqual([]);
    });
  });
});
