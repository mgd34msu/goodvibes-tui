import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SystemMessageRouter, createSystemMessageRouter } from '../../core/system-message-router.ts';
import type { SystemMessagesPanel, SystemMessagePriority } from '../../panels/system-messages-panel.ts';
import type { ConversationManager } from '../../core/conversation.ts';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeConversation(): { addSystemMessage: ReturnType<typeof mock>; _messages: string[] } {
  const _messages: string[] = [];
  const addSystemMessage = mock((msg: string) => { _messages.push(msg); });
  return { addSystemMessage, _messages } as unknown as { addSystemMessage: ReturnType<typeof mock>; _messages: string[] };
}

function makePanel(): { push: ReturnType<typeof mock>; handleInput: ReturnType<typeof mock>; _pushed: { text: string; priority: SystemMessagePriority }[] } {
  const _pushed: { text: string; priority: SystemMessagePriority }[] = [];
  const push = mock((text: string, priority: SystemMessagePriority) => { _pushed.push({ text, priority }); });
  const handleInput = mock((_key: string): boolean => true);
  return { push, handleInput, _pushed } as unknown as { push: ReturnType<typeof mock>; handleInput: ReturnType<typeof mock>; _pushed: { text: string; priority: SystemMessagePriority }[] };
}

// ---------------------------------------------------------------------------
// classifyPriority — tested indirectly through routeAuto
// ---------------------------------------------------------------------------

describe('classifyPriority (via routeAuto)', () => {
  let conv: ReturnType<typeof makeConversation>;
  let panel: ReturnType<typeof makePanel>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    panel = makePanel();
    router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as SystemMessagesPanel,
    );
  });

  test('messages with [Model] prefix classify as high', () => {
    router.routeAuto('[Model] Switched to gpt-5 (openai)');
    expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('messages with [Session] saved classify as high', () => {
    router.routeAuto('[Session] saved abc123');
    expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('messages with [Recovery] Failed classify as high', () => {
    router.routeAuto('[Recovery] Failed to restore: disk error');
    expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('messages with fatal classify as high', () => {
    router.routeAuto('A fatal error occurred');
    expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('[Scan] messages classify as low (not sent to conversation)', () => {
    router.routeAuto('[Scan] Found ollama at localhost:11434');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledTimes(1);
    expect(panel._pushed[0]!.priority).toBe('low');
  });

  test('[Agents] status messages classify as low', () => {
    router.routeAuto('[Agents] 3 running:\n  abc12345: working');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel._pushed[0]!.priority).toBe('low');
  });

  test('[MCP] discovery messages classify as low', () => {
    router.routeAuto('[MCP] Discovered server myserver (npx myserver-mcp).');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// routeSystemMessage
// ---------------------------------------------------------------------------

describe('routeSystemMessage', () => {
  let conv: ReturnType<typeof makeConversation>;
  let panel: ReturnType<typeof makePanel>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    panel = makePanel();
    router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as SystemMessagesPanel,
    );
  });

  test('high priority routes to both conversation and panel', () => {
    router.routeSystemMessage('high message', 'high');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('high message');
    expect(panel.push).toHaveBeenCalledWith('high message', 'high');
  });

  test('low priority routes to panel only', () => {
    router.routeSystemMessage('low message', 'low');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledWith('low message', 'low');
  });

  test('high convenience method routes high', () => {
    router.high('important!');
    expect(conv.addSystemMessage).toHaveBeenCalledWith('important!');
    expect(panel.push).toHaveBeenCalledWith('important!', 'high');
  });

  test('low convenience method routes low (panel only)', () => {
    router.low('noisy status');
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
    expect(panel.push).toHaveBeenCalledWith('noisy status', 'low');
  });

  test('null panel does not throw on high route', () => {
    const noPanel = createSystemMessageRouter(conv as unknown as ConversationManager, null);
    expect(() => noPanel.high('msg')).not.toThrow();
    expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('null panel does not throw on low route', () => {
    const noPanel = createSystemMessageRouter(conv as unknown as ConversationManager, null);
    expect(() => noPanel.low('msg')).not.toThrow();
    expect(conv.addSystemMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// routeAuto — classification
// ---------------------------------------------------------------------------

describe('routeAuto classification', () => {
  let conv: ReturnType<typeof makeConversation>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    router = createSystemMessageRouter(conv as unknown as ConversationManager, null);
  });

  const highCases = [
    '[Model] Switched to claude-4',
    '[Compaction] Compacted context',
    '[Recovery] Failed to restore',
    'fatal error in module',
    'crash detected',
    '[Provider] switch to anthropic',
    '[Session] loaded abc',
    '[Session] restored abc',
    'An unhandled exception was thrown',
  ];

  const lowCases = [
    '[Scan] Found server at localhost',
    '[Local] ollama at localhost:11434',
    '[Agents] 2 running: task a',
    '[MCP] Discovered server foo',
    '[WRFC] Chain abc123 started',
    '[Plugin] loaded my-plugin',
  ];

  for (const msg of highCases) {
    test(`classifies as high: "${msg.slice(0, 40)}"`, () => {
      router.routeAuto(msg);
      expect(conv.addSystemMessage).toHaveBeenCalledTimes(1);
      conv.addSystemMessage.mockClear();
    });
  }

  for (const msg of lowCases) {
    test(`classifies as low: "${msg.slice(0, 40)}"`, () => {
      router.routeAuto(msg);
      expect(conv.addSystemMessage).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Panel: push renders and handleInput scroll
// ---------------------------------------------------------------------------

describe('SystemMessagesPanel integration', () => {
  test('push sends to panel with correct priority', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as SystemMessagesPanel,
    );

    router.low('[Scan] discovered server');
    expect(panel._pushed).toHaveLength(1);
    expect(panel._pushed[0]!.text).toBe('[Scan] discovered server');
    expect(panel._pushed[0]!.priority).toBe('low');
  });

  test('high push is captured in panel with high priority', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as SystemMessagesPanel,
    );

    router.high('[Model] switched');
    expect(panel._pushed[0]!.priority).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// getPanel
// ---------------------------------------------------------------------------

describe('getPanel', () => {
  test('returns the panel passed at construction', () => {
    const conv = makeConversation();
    const panel = makePanel();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      panel as unknown as SystemMessagesPanel,
    );
    expect(router.getPanel()).toBe(panel as unknown as SystemMessagesPanel);
  });

  test('returns null when no panel passed', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager);
    expect(router.getPanel()).toBeNull();
  });
});
