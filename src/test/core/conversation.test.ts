import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager, sumConversationUsage } from '../../core/conversation';
import type { ConversationMessageSnapshot } from '../../core/conversation';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

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

  describe('user-action receipts vs the splash', () => {
    // Regression coverage for the boot defect where the recovery modal's
    // Resume/Keep/Remove receipt landed in the transcript while the splash
    // still owned the screen: addTypedSystemMessage's plain form is ambient
    // boot chatter and must stay under the splash, while a message marked
    // isUserReceipt (what SystemMessageRouter.userReceipt() sends for a
    // recovery-modal answer) must displace it, exactly like a user message.

    test('an ambient system message (no isUserReceipt) never displaces the splash', () => {
      const c = new ConversationManager(() => 120);
      c.addTypedSystemMessage('Provider anthropic registered — from last session', 'system');
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).toContain('██████╗');
      expect(frame).not.toContain('Provider anthropic registered');
    });

    test('a user-action receipt (isUserReceipt: true) displaces the splash and is visible', () => {
      const c = new ConversationManager(() => 120);
      c.addTypedSystemMessage(
        'Recovery point removed (session sess-abc123) — it will not be offered again, even if the file reappears.',
        'system',
        { isUserReceipt: true },
      );
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).not.toContain('██████╗');
      expect(frame).toContain('Recovery point removed (session sess-abc123)');
    });

    test('undo removes a receipt outright — a later message recycling its freed index is ordinary ambient content', () => {
      const c = new ConversationManager(() => 120);
      c.addUserMessage('first');
      c.addAssistantMessage('reply');
      c.addUserMessage('second');
      c.addTypedSystemMessage('Recovery point kept (session sess-xyz) — it will be offered again next launch.', 'system', { isUserReceipt: true });
      c.undo(); // removes the last turn ('second' + the receipt) as one unit
      c.addTypedSystemMessage('Provider anthropic registered', 'system'); // recycles the freed index, ambient (no isUserReceipt)
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).not.toContain('██████╗'); // 'first'/'reply' remain — real content, splash stays hidden regardless
      expect(frame).not.toContain('Recovery point kept'); // undone — gone from the transcript entirely
    });
  });

  describe('clearDisplay', () => {
    test('clearDisplay zeros getDisplayBlocks', () => {
      cm.addUserMessage('hello');
      cm.addAssistantMessage('world');
      // Force display to be populated
      expect(cm.getDisplayBlocks().length).toBeGreaterThan(0);

      cm.clearDisplay();
      expect(cm.getDisplayBlocks().length).toBe(0);
    });

    test('clearDisplay leaves LLM message history intact', () => {
      cm.addUserMessage('hello');
      cm.addAssistantMessage('world');
      const snapshotBefore = cm.getMessageSnapshot();

      cm.clearDisplay();

      const snapshotAfter = cm.getMessageSnapshot();
      expect(snapshotAfter.length).toBe(snapshotBefore.length);
    });

    test('after clearDisplay, a new message adds only that message to the display', () => {
      cm.addUserMessage('hello');
      cm.addAssistantMessage('world');
      cm.clearDisplay();
      expect(cm.getDisplayBlocks().length).toBe(0);

      cm.addUserMessage('new message after clear');
      // Display now contains lines from the new message only
      const blocks = cm.getDisplayBlocks();
      expect(blocks.length).toBeGreaterThan(0);
      const displayText = blocks.map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(displayText).toContain('new message after clear');
      // The old messages should NOT appear in display after clear
      expect(displayText).not.toContain('hello');
      expect(displayText).not.toContain('world');
    });

    test('getMessagesForLLM is unaffected by clearDisplay', () => {
      cm.addUserMessage('persistent user');
      cm.addAssistantMessage('persistent assistant');
      cm.clearDisplay();
      const msgs = cm.getMessagesForLLM();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ role: 'user', content: 'persistent user' });
      expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'persistent assistant' });
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

  // after a session resume replays historical messages, a freshly
  // constructed Orchestrator's `usage` starts at {0,0,0,0} (SDK gap — never
  // persisted/reseeded). sumConversationUsage() is the TUI-side helper that
  // recomputes real totals from the replayed history so bootstrap-shell.ts
  // can hydrate orchestrator.usage before the footer's first render.
  describe('sumConversationUsage', () => {
    test('empty history sums to all zeros', () => {
      const { usage, lastInputTokens } = sumConversationUsage([]);
      expect(usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(lastInputTokens).toBe(0);
    });

    test('ignores messages without usage (user/system/tool, or assistant with no usage)', () => {
      const messages: ConversationMessageSnapshot[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'sys' },
      ];
      const { usage, lastInputTokens } = sumConversationUsage(messages);
      expect(usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(lastInputTokens).toBe(0);
    });

    test('sums inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens across multiple assistant messages', () => {
      const messages: ConversationMessageSnapshot[] = [
        { role: 'user', content: 'turn 1' },
        { role: 'assistant', content: 'reply 1', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 10 } },
        { role: 'user', content: 'turn 2' },
        { role: 'assistant', content: 'reply 2', usage: { inputTokens: 200, outputTokens: 40 } },
      ];
      const { usage, lastInputTokens } = sumConversationUsage(messages);
      expect(usage).toEqual({ input: 300, output: 60, cacheRead: 5, cacheWrite: 10 });
      // lastInputTokens reflects the LAST assistant message's own figure only
      // (context-window occupancy), not a running sum — 200 + 0 + 0.
      expect(lastInputTokens).toBe(200);
    });

    test('lastInputTokens includes the last assistant message own cache tokens', () => {
      const messages: ConversationMessageSnapshot[] = [
        { role: 'assistant', content: 'a', usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 25 } },
      ];
      const { lastInputTokens } = sumConversationUsage(messages);
      expect(lastInputTokens).toBe(1000 + 300 + 25);
    });
  });
});
