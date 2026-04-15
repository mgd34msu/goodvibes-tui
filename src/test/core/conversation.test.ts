import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { getDisplayWidth } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';

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
      const toolCalls = [{ id: 'c1', name: 'read', arguments: { path: 'foo.ts' } }];
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

    test('addToolResults carries through the matching tool name when a prior assistant tool call exists', () => {
      cm.addAssistantMessage('calling tool', {
        toolCalls: [{ id: 'call-web-1', name: 'web_search', arguments: { query: 'dllm language model' } }],
      });
      cm.addToolResults([{ callId: 'call-web-1', success: true, output: 'file content' }]);
      const msgs = cm.getMessagesForLLM();
      expect(msgs[1]).toMatchObject({ role: 'tool', callId: 'call-web-1', name: 'web_search' });
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

  describe('block lookup', () => {
    test('prefers the block containing a line over the nearest later block start', () => {
      cm.addAssistantMessage([
        '```ts',
        'function first() {',
        '  const value = 1;',
        '  return value;',
        '}',
        '```',
        '',
        '```ts',
        'function second() {',
        '  return 2;',
        '}',
        '```',
      ].join('\n'));
      cm.getDisplayBlocks();

      const [firstBlock, secondBlock] = cm.getBlockRegistry().filter((block) => block.type === 'code');
      expect(firstBlock).toBeDefined();
      expect(secondBlock).toBeDefined();

      const targetLine = firstBlock!.startLine + firstBlock!.lineCount - 1;
      expect(Math.abs(secondBlock!.startLine - targetLine)).toBeLessThan(Math.abs(firstBlock!.startLine - targetLine));
      expect(cm.findNearestBlock(targetLine, 'code')).toBe(firstBlock);
    });
  });

  describe('splash suppression', () => {
    test('rebuilds history when splash suppression changes', () => {
      const splashConversation = new ConversationManager(() => 40);
      const before = splashConversation.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(before).toContain('██████╗');

      splashConversation.setSplashSuppressed(true);
      const after = splashConversation.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(after).not.toContain('██████╗');
    });

    test('rebuilds splash against a narrower width provider before suppression', () => {
      let width = 96;
      const splashConversation = new ConversationManager(() => width);
      const wide = splashConversation.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join(''));
      expect(wide.join('\n')).toContain('[ ｇｏｏｄ ｖｉｂｅｓ ・ Ａ Ｉ ・ いい雰囲気 ]');
      expect(wide.every((line) => getDisplayWidth(line) <= width)).toBe(true);

      width = 34;
      splashConversation.setWidthProvider(() => width);
      const narrow = splashConversation.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join(''));
      expect(narrow.join('\n')).toContain('██████╗');
      expect(narrow.every((line) => getDisplayWidth(line) <= width)).toBe(true);

      splashConversation.setSplashSuppressed(true);
      const suppressed = splashConversation.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join(''));
      expect(suppressed.join('\n')).not.toContain('██████╗');
      expect(suppressed.every((line) => getDisplayWidth(line) <= width)).toBe(true);
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
