import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { SystemMessageRouter, createSystemMessageRouter, type SystemMessageKind, type SystemMessageTarget } from '../../core/system-message-router.ts';
import type { ConversationManager } from '../../core/conversation';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Minimal stubs
//
// (the purge): SystemMessagesPanel was DELETE-disposition and has been
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

  test('[Agents] periodic "N running" snapshots are suppressed; lifecycle lines still reach conversation (1d)', () => {
    // The 30s "N running:" snapshot is transcript churn — dropped; the same live
    // detail is shown in the fleet panel and the footer count.
    router.routeAuto('[Agents] 3 running:\n  abc12345: working');
    expect(conv.addTypedSystemMessage).not.toHaveBeenCalled();
    // A meaningful lifecycle line is not a snapshot and still routes.
    router.routeAuto('[Agents] ✓ abc12345 completed');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith('[Agents] ✓ abc12345 completed', 'operational');
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

  test('panel-targeted routes fall back to conversation (no panel exists)', () => {
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
    // Not the "N running:" periodic snapshot (that is suppressed — see below);
    // a lifecycle line still reaches the transcript.
    '[Agents] ✓ task a completed',
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

// ---------------------------------------------------------------------------
// Noise gate integration (item 1)
// ---------------------------------------------------------------------------

describe('router noise gate', () => {
  // Papercut sweep item 2: this used to assert the folded line landed in the
  // transcript (conv._messages). The first-run evaluation wanted this boot
  // plumbing OUT of the transcript entirely — it now goes to the activity
  // log only, and stays reachable live via /health provider and /model.
  test('1b — a provider-replay burst folds to one activity-log entry and never reaches the transcript', async () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver());
    const logSpy = spyOn(logger, 'info').mockImplementation(() => {});
    try {
      router.low('[Local] ollama at localhost:11434 (2 models) — from last session');
      router.low('[Local] lmstudio at localhost:1234 (5 models) — from last session');
      // Nothing emitted synchronously — the burst is buffered.
      expect(conv.addTypedSystemMessage).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      await Promise.resolve();
      // Never reaches the transcript, folded or otherwise.
      expect(conv._messages).toEqual([]);
      expect(conv.addTypedSystemMessage).not.toHaveBeenCalled();
      // Reaches the activity log exactly once, folded, with structured data.
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        '[Local] Restored 2 providers from last session (ollama, lmstudio)',
        { count: 2, providers: ['ollama', 'lmstudio'] },
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test('1c — replay lines for a terminal chain are dropped, active ones pass', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver(),
      { isChainTerminal: (id) => id === 'dead' },
    );
    router.low('[Replay] WRFC chain dead transitioned pending → engineering — waiting for action (first notified 1 turn ago)');
    router.low('[Replay] WRFC chain live transitioned pending → engineering — waiting for action (first notified 1 turn ago)');
    expect(conv._messages).toEqual([
      '[Replay] WRFC chain live transitioned pending → engineering — waiting for action (first notified 1 turn ago)',
    ]);
  });

  test('1d — periodic running-agents snapshots never reach the transcript', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver());
    router.low('[Agents] 2 running:\n  abc: Turn 3 · Thinking…');
    expect(conv.addTypedSystemMessage).not.toHaveBeenCalled();
  });
});

describe('userReceipt', () => {
  // Regression coverage for the boot defect: the recovery modal's
  // Resume/Keep/Remove receipt landed in the transcript while the splash
  // still owned the screen, because it went through the same path as ambient
  // system chatter. userReceipt() is the fix's entry point — it must reach
  // the conversation unconditionally (no noise gate, no routing-target
  // detour) and mark the message so ConversationManager treats it as real
  // visible content instead of quiet boot chatter.
  test('reaches the conversation directly, marked isUserReceipt, bypassing the noise gate and routing target', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver({ system: 'panel' }));
    router.userReceipt('Recovery point removed (session sess-abc123) — it will not be offered again, even if the file reappears.');
    expect(conv.addTypedSystemMessage).toHaveBeenCalledTimes(1);
    expect(conv.addTypedSystemMessage).toHaveBeenCalledWith(
      'Recovery point removed (session sess-abc123) — it will not be offered again, even if the file reappears.',
      'system',
      { isUserReceipt: true },
    );
  });

  test('a provider-replay-shaped line still reaches the conversation as a receipt — the noise gate never runs', () => {
    // Same text shape the noise gate would otherwise fold/drop (see the
    // 'router noise gate' describe block above) — userReceipt() must not
    // route through classifyNoise at all, because a receipt for an explicit
    // user action is never noise.
    const conv = makeConversation();
    const router = createSystemMessageRouter(conv as unknown as ConversationManager, makeTargetResolver());
    router.userReceipt('[Local] ollama at localhost:11434 (2 models) — from last session');
    expect(conv._messages).toEqual(['[Local] ollama at localhost:11434 (2 models) — from last session']);
  });
});
