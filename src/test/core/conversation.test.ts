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
      c.addTypedSystemMessage('Provider anthropic registered, from last session', 'system');
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).toContain('██████╗');
      expect(frame).not.toContain('Provider anthropic registered');
    });

    test('a user-action receipt is a notice: it reaches the notice sink in full and leaves the splash up', () => {
      const c = new ConversationManager(() => 120);
      const seen: Array<{ content: string; restored: boolean }> = [];
      c.setNoticeSink((content, { restored }) => seen.push({ content, restored }));
      const receipt = 'Recovery point removed (session sess-abc123); it will not be offered again, even if the file reappears.';
      c.addTypedSystemMessage(receipt, 'system');
      expect(seen).toEqual([{ content: receipt, restored: false }]);
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).toContain('██████╗');
      expect(frame).not.toContain('Recovery point removed');
    });

    test('undo removes a receipt outright; a later message recycling its freed index is ordinary ambient content', () => {
      const c = new ConversationManager(() => 120);
      c.addUserMessage('first');
      c.addAssistantMessage('reply');
      c.addUserMessage('second');
      c.addTypedSystemMessage('Recovery point kept (session sess-xyz); it will be offered again next launch.', 'system');
      c.undo(); // removes the last turn ('second' + the receipt) as one unit
      c.addTypedSystemMessage('Provider anthropic registered', 'system'); // recycles the freed index, ambient (no isUserReceipt)
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).not.toContain('██████╗'); // 'first'/'reply' remain, real content, splash stays hidden regardless
      expect(frame).not.toContain('Recovery point kept'); // undone, gone from the transcript entirely
    });
  });

  describe('any submission retires the splash', () => {
    // Owner ruling: the splash yields on EITHER text input OR command input.
    // The user-action-receipt rule above stays for the boot-modal case; this
    // is the general trigger and supersedes it, a slash command that renders
    // nothing into the transcript must still take the splash down, and it must
    // not come back while the run continues.

    test('dismissSplash() takes the splash down with an empty transcript', () => {
      const c = new ConversationManager(() => 120);
      expect(c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n')).toContain('██████╗');

      c.dismissSplash(); // what a slash command submission does

      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).not.toContain('██████╗');
      expect(frame).not.toContain('Ctrl+P panels');
    });

    test('the first slash command\'s output survives the dismissal it causes (live defect: /context window printed nothing)', () => {
      const c = new ConversationManager(() => 120);
      c.getDisplayBlocks(); // the splash is on screen

      // The command route: dismiss, then the command logs its display-only
      // output in the same tick, then the next frame renders.
      c.dismissSplash();
      c.log('Context window for Free Models Router: 200,000 tokens');

      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).toContain('Context window for Free Models Router: 200,000 tokens');
      expect(frame).not.toContain('██████╗');
      expect(c.consumeSplashTransition()).toBe(true);
    });

    test('dismissing when the splash is not on screen leaves logged lines alone', () => {
      const c = new ConversationManager(() => 120);
      c.addUserMessage('resumed work');
      c.getDisplayBlocks();
      c.log('resume notice');
      c.dismissSplash();
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).toContain('resume notice');
    });

    test('display-only command output survives a resize, in place (live defect: /context window output vanished on resize)', () => {
      let width = 120;
      const c = new ConversationManager(() => width);
      const frame = (): string => c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      c.getDisplayBlocks();
      c.dismissSplash();
      c.addUserMessage('first question');
      c.addAssistantMessage('first answer', { model: 'm1' });
      c.getDisplayBlocks();
      c.log('Context window for Free Models Router: 200,000 tokens');
      c.addUserMessage('second question');
      expect(frame()).toContain('Context window for Free Models Router: 200,000 tokens');

      // A resize rebuilds the whole transcript at the new width.
      width = 90;
      const after = frame();
      expect(after).toContain('Context window for Free Models Router: 200,000 tokens');
      // Still between the messages it was printed between.
      expect(after.indexOf('first answer')).toBeLessThan(after.indexOf('Context window for Free Models Router'));
      expect(after.indexOf('Context window for Free Models Router')).toBeLessThan(after.indexOf('second question'));
      // And back again, drawn once.
      width = 120;
      expect(frame().split('Context window for Free Models Router').length - 1).toBe(1);
    });

    test('output printed while a reply streams stays below the streamed text across deltas and a resize', () => {
      let width = 120;
      const c = new ConversationManager(() => width);
      const frame = (): string => c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      c.dismissSplash();
      c.addUserMessage('question');
      c.getDisplayBlocks();
      c.startStreamingBlock();
      c.updateStreamingBlock('partial answer');
      c.log('printed mid-turn');
      c.updateStreamingBlock('partial answer grows');
      let shown = frame();
      expect(shown).toContain('printed mid-turn');
      expect(shown.indexOf('partial answer grows')).toBeLessThan(shown.indexOf('printed mid-turn'));
      width = 100;
      c.updateStreamingBlock('partial answer grows more');
      shown = frame();
      expect(shown.split('printed mid-turn').length - 1).toBe(1);
      expect(shown.indexOf('partial answer grows more')).toBeLessThan(shown.indexOf('printed mid-turn'));
    });

    test('output printed over the splash retires it and stays through a resize', () => {
      let width = 120;
      const c = new ConversationManager(() => width);
      const frame = (): string => c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame()).toContain('██████╗');
      c.log('[Ctrl+Y: No block found nearby]');
      expect(frame()).toContain('[Ctrl+Y: No block found nearby]');
      width = 90;
      const shown = frame();
      expect(shown).toContain('[Ctrl+Y: No block found nearby]');
      expect(shown).not.toContain('██████╗');
    });

    test('clearing the display drops kept display-only output', () => {
      let width = 120;
      const c = new ConversationManager(() => width);
      c.dismissSplash();
      c.addUserMessage('q');
      c.getDisplayBlocks();
      c.log('old receipt');
      c.clearDisplay();
      width = 100;
      const shown = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(shown).not.toContain('old receipt');
      expect(c.getDisplayOnlyCount()).toBe(0);
    });

    test('the splash stays gone for the rest of the run, including when the panel posture toggles', () => {
      const c = new ConversationManager(() => 120);
      c.getDisplayBlocks();
      c.dismissSplash();
      c.setSplashSuppressed(true);  // panel workspace opened
      c.setSplashSuppressed(false); // …and closed again, the per-frame posture is back to "allowed"
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).not.toContain('██████╗');
    });

    test('a turn flows normally once the splash has yielded, and a notice draws no row', () => {
      const c = new ConversationManager(() => 120);
      c.getDisplayBlocks();
      c.dismissSplash();
      c.addTypedSystemMessage('[Health] providers: 3 reachable', 'system');
      c.addUserMessage('hello');
      c.addAssistantMessage('hi there');
      const frame = c.getDisplayBlocks().map((line) => line.map((cell) => cell.char).join('')).join('\n');
      expect(frame).not.toContain('██████╗');
      // The turn flows; the notice is a toast and a history entry, not a row.
      expect(frame).toContain('hi there');
      expect(frame).not.toContain('[Health] providers: 3 reachable');
    });

    test('consumeSplashTransition() reports the splash→transcript edge exactly once', () => {
      const c = new ConversationManager(() => 120);
      c.getDisplayBlocks();                    // splash frame
      expect(c.consumeSplashTransition()).toBe(false);

      c.dismissSplash();
      c.getDisplayBlocks();                    // first transcript frame
      expect(c.consumeSplashTransition()).toBe(true);

      c.addUserMessage('later content');
      c.getDisplayBlocks();
      expect(c.consumeSplashTransition()).toBe(false); // not re-armed by ordinary frames
    });

    test('a user message still takes the splash down on its own (no dismissal needed)', () => {
      const c = new ConversationManager(() => 120);
      c.getDisplayBlocks();
      c.addUserMessage('hello');
      c.getDisplayBlocks();
      expect(c.consumeSplashTransition()).toBe(true);
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
  // constructed Orchestrator's `usage` starts at {0,0,0,0} (SDK gap, never
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
      // (context-window occupancy), not a running sum, 200 + 0 + 0.
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
