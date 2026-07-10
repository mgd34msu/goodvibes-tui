/**
 * Gate: the composed daemon's unified-rewind verbs (rewind.plan / rewind.apply)
 * serve CONVERSATION scope live in this process — not just files.
 *
 * The SDK's registerGatewayVerbGroups constructs the UnifiedRewindService with
 * `conversation: deps.conversationRewindPort ?? null`; absent that port,
 * conversation rewind is honestly reported unavailable on the wire. The TUI's
 * composition root (runtime/services.ts) now threads a conversationRewindPort
 * that resolves each anchor's live ConversationManager from the per-session
 * registry the TUI populates at bootstrap (conversation-rewind-port.ts).
 *
 * This test pins that wiring the same way gateway-initiative-verbs.test.ts pins
 * the initiative families: compose the real vendored runtime, register a live
 * conversation + turn boundary for a session, then invoke rewind.plan over the
 * composed catalog and assert the conversation half comes back AVAILABLE with
 * the truncation counts — proving the port is threaded, not a 501/absent facade.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';
import { recordTurnAnchor, clearTurnAnchors } from '../../core/rewind-turn-anchors.ts';
import {
  registerSessionConversation,
  unregisterSessionConversation,
} from '../../runtime/conversation-rewind-port.ts';
import type { ConversationManager } from '../../core/conversation.ts';

const SESSION = 's-daemon-rewind';

/** Minimal conversation the port needs: message count + snapshot/truncate. */
function makeFakeConversation(count: number): ConversationManager {
  let messages = Array.from({ length: count }, (_, i) => ({ role: 'user', content: `m${i}` }));
  return {
    getMessageCount: () => messages.length,
    toJSON: () => ({ messages: messages.map((m) => ({ ...m })) }),
    fromJSON: (data: { messages: unknown[] }) => { messages = data.messages.map((m) => ({ ...(m as object) })) as typeof messages; },
    removeMessagesAfter: (n: number) => { messages = messages.slice(0, n); },
    rebuildHistory: () => {},
  } as unknown as ConversationManager;
}

interface RewindPlanResult {
  readonly conversation: { readonly available: boolean; readonly messagesToDrop: number; readonly messagesRemaining: number } | null;
  readonly token: string;
  readonly warnings: readonly string[];
}

afterAll(() => {
  clearTurnAnchors(SESSION);
  unregisterSessionConversation(SESSION);
});

describe('composed daemon serves conversation-scope rewind live', () => {
  const services = getTestRuntimeServices();

  test('rewind.plan + rewind.apply descriptors are registered in the composed catalog', () => {
    expect(services.gatewayMethods.get('rewind.plan')).toBeTruthy();
    expect(services.gatewayMethods.get('rewind.apply')).toBeTruthy();
  });

  test('rewind.plan conversation scope resolves the live session conversation (available, real counts)', async () => {
    registerSessionConversation(SESSION, makeFakeConversation(5)); // 5 messages now
    recordTurnAnchor(SESSION, { turnId: 't-daemon-1', label: 'do the thing', messageCount: 3, at: Date.now() }); // boundary keeps 3

    const plan = (await services.gatewayMethods.invoke('rewind.plan', {
      methodId: 'rewind.plan',
      body: { sessionId: SESSION, turnId: 't-daemon-1', scope: 'conversation' },
    } as never)) as RewindPlanResult;

    expect(plan.conversation).toBeTruthy();
    expect(plan.conversation?.available).toBe(true); // the port is threaded — not the absent-store default
    expect(plan.conversation?.messagesToDrop).toBe(2);
    expect(plan.conversation?.messagesRemaining).toBe(3);
    expect(typeof plan.token).toBe('string');
  });

  test('rewind.apply conversation scope truncates the live conversation via the daemon verb', async () => {
    const conv = makeFakeConversation(5);
    registerSessionConversation(SESSION, conv);
    recordTurnAnchor(SESSION, { turnId: 't-daemon-2', label: 'apply', messageCount: 2, at: Date.now() });

    const applied = (await services.gatewayMethods.invoke('rewind.apply', {
      methodId: 'rewind.apply',
      body: { sessionId: SESSION, turnId: 't-daemon-2', scope: 'conversation', confirm: true },
    } as never)) as { receipt: { conversation: { rewound: boolean; droppedMessages: number } | null } | null; refused: boolean };

    expect(applied.refused).toBe(false);
    expect(applied.receipt?.conversation?.rewound).toBe(true);
    expect(applied.receipt?.conversation?.droppedMessages).toBe(3);
    expect(conv.getMessageCount()).toBe(2); // the live conversation was actually truncated
  });
});
