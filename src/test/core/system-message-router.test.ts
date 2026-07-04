import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SystemMessageRouter, createSystemMessageRouter, type SystemMessageKind, type SystemMessageTarget } from '../../core/system-message-router.ts';
import type { ConversationManager } from '../../core/conversation';

// ---------------------------------------------------------------------------
// Minimal stubs
//
// W6.1 (the purge): SystemMessagesPanel was DELETE-disposition and has been
// removed. SystemMessageRouter no longer takes a panel at all — every
// message now reaches conversation.addTypedSystemMessage() (see the class
// doc in system-message-router.ts for why that's the correct behavior, not
// a regression: resolveSystemMessageDelivery always falls back to
// conversation when hasPanel is false).
// ---------------------------------------------------------------------------

function makeConversation(): {
  addSystemMessage: ReturnType<typeof mock>;
  addTypedSystemMessage: ReturnType<typeof mock>;
  _messages: string[];
  _typedMessages: Array<{ msg: string; kind: string }>;
} {
  const _messages: string[] = [];
  const _typedMessages: Array<{ msg: string; kind: string }> = [];
  // addSystemMessage is a plain-kind fallback (bare callers without kind info)
  const addSystemMessage = mock((msg: string) => { _messages.push(msg); });
  // addTypedSystemMessage is called by the router with a kind tag
  const addTypedSystemMessage = mock((msg: string, kind: string) => {
    _messages.push(msg);
    _typedMessages.push({ msg, kind });
  });
  return { addSystemMessage, addTypedSystemMessage, _messages, _typedMessages } as unknown as {
    addSystemMessage: ReturnType<typeof mock>;
    addTypedSystemMessage: ReturnType<typeof mock>;
    _messages: string[];
    _typedMessages: Array<{ msg: string; kind: string }>;
  };
}

function makeTargetResolver(
  overrides: Partial<Record<SystemMessageKind, SystemMessageTarget>> = {},
): (kind: SystemMessageKind) => SystemMessageTarget {
  return (kind) => overrides[kind] ?? (kind === 'wrfc' ? 'both' : 'panel');
}

// ---------------------------------------------------------------------------
// classifyPriority — tested indirectly through routeAuto
// ---------------------------------------------------------------------------

describe('classifyPriority (via routeAuto)', () => {
  let conv: ReturnType<typeof makeConversation>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver(),
    );
  });

  test('messages with [Model] prefix classify as high and reach conversation', () => {
    router.routeAuto('[Model] Switched to gpt-5 (openai)');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Model] Switched to gpt-5 (openai)', 'system');
  });

  test('messages with [Session] saved classify as high and reach conversation', () => {
    router.routeAuto('[Session] saved abc123');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Session] saved abc123', 'system');
  });

  test('messages with [Recovery] Failed classify as high and reach conversation', () => {
    router.routeAuto('[Recovery] Failed to restore: disk error');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Recovery] Failed to restore: disk error', 'system');
  });

  test('messages with fatal classify as high and reach conversation', () => {
    router.routeAuto('A fatal error occurred');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('A fatal error occurred', 'system');
  });

  test('[Scan] messages classify as low but still reach conversation (no panel to absorb them)', () => {
    router.routeAuto('[Scan] Found ollama at localhost:11434');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Scan] Found ollama at localhost:11434', 'operational');
  });

  test('[Agents] status messages classify as low but still reach conversation', () => {
    router.routeAuto('[Agents] 3 running:\n  abc12345: working');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Agents] 3 running:\n  abc12345: working', 'operational');
  });

  test('[Tool] activity messages classify as operational and can route separately', () => {
    const opsRouter = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ operational: 'conversation' }),
    );
    opsRouter.routeAuto('[Tool] edit applied to src/main.ts');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Tool] edit applied to src/main.ts', 'operational');
  });

  test('[MCP] discovery messages classify as low and still reach conversation', () => {
    router.routeAuto('[MCP] Discovered server myserver (npx myserver-mcp).');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[MCP] Discovered server myserver (npx myserver-mcp).', 'operational');
  });
});

// ---------------------------------------------------------------------------
// routeSystemMessage
// ---------------------------------------------------------------------------

describe('routeSystemMessage', () => {
  let conv: ReturnType<typeof makeConversation>;
  let router: SystemMessageRouter;

  beforeEach(() => {
    conv = makeConversation();
    router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver(),
    );
  });

  test('panel-only targeted messages fall back to conversation (no panel attached)', () => {
    router.routeSystemMessage('high message', 'high');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('high message', 'system');
  });

  test('low priority also falls back to conversation', () => {
    router.routeSystemMessage('low message', 'low');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('low message', 'system');
  });

  test('high convenience method routes to conversation', () => {
    router.high('important!');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('important!', 'system');
  });

  test('wrfc convenience method routes to conversation under the wrfc kind', () => {
    router.wrfc('[WRFC] Chain abc started');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[WRFC] Chain abc started', 'wrfc');
  });

  test('low convenience method routes to conversation', () => {
    router.low('noisy status');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('noisy status', 'system');
  });

  test('does not throw on high route', () => {
    const r = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver({ system: 'conversation' }));
    expect(() => r.high('msg')).not.toThrow();
    expect(conv.addTypedSystemMessage).toHaveBeenCalledTimes(1);
  });

  test('does not throw on low route', () => {
    const r = createSystemMessageRouter(conv as unknown as ConversationManager);
    expect(() => r.low('msg')).not.toThrow();
    // low routes to panel-only by default; with no panel it falls back to conversation
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('msg', 'system');
  });

  test('panel-targeted routes fall back to conversation (W6.1: no panel exists)', () => {
    const r = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver({ system: 'panel' }));
    r.routeSystemMessage('panel fallback', 'low');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('panel fallback', 'system');
  });

  test('custom system target of both still reaches conversation', () => {
    const bothRouter = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );
    bothRouter.routeSystemMessage('both message', 'high');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('both message', 'system');
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
    router = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver());
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
    '[Plugin] loaded my-plugin',
    '[Tool] edit wrote app.ts',
  ];

  for (const msg of highCases) {
    test(`classifies as high: "${msg.slice(0, 40)}"`, () => {
      router.routeAuto(msg);
      // High-priority system messages use kind='system' and route to conversation
      expect(conv.addTypedSystemMessage).toHaveBeenCalledWith(msg, 'system');
    });
  }

  for (const msg of lowCases) {
    test(`classifies as low: "${msg.slice(0, 40)}"`, () => {
      router.routeAuto(msg);
      // Low cases are 'operational' kind; without panel they fall back to conversation
      expect(conv.addTypedSystemMessage).toHaveBeenCalledWith(msg, 'operational');
    });
  }

  test('WRFC messages classify as wrfc and follow WRFC target policy', () => {
    router.routeAuto('[WRFC] Chain abc123 started');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[WRFC] Chain abc123 started', 'wrfc');
  });
});
