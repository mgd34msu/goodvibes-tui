/**
 * ui-live-run-9 item 2: /notifications showed each chain or agent event twice,
 * once under its plain title (the runtime-bus bridge) and once as the
 * "[WRFC] …" / "[Agents] …" line the SDK writes for the same event. Every
 * event is one entry, under its plain title, whichever arrives first.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope, registerHostRuntimeEvents } from '@/runtime/index.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { createSystemMessageRouter } from '../../core/system-message-router.ts';
import { createNotificationDispatcher, createShellNoticeSink, wireRuntimeNotificationBridge } from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { bridgeNotificationFeedToToasts, ToastCenter } from '../../renderer/toast-center.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

const ctx = { sessionId: 's', traceId: 't', source: 'test' };

function shell(options: { bridgeFirst: boolean; verbosity?: 'minimal' | 'normal' }) {
  const bus = new RuntimeEventBus();
  const feed = new NotificationFeed();
  const toasts = new ToastCenter(() => 0, () => {});
  bridgeNotificationFeedToToasts(feed, toasts);
  const conversation = new ConversationManager(() => 100);
  conversation.setNoticeSink(createShellNoticeSink(feed));
  const router = createSystemMessageRouter(conversation);
  const dispatcher = createNotificationDispatcher({ get: configGetStub() }, feed);
  if (options.verbosity) for (const domain of ['agents', 'workflows']) dispatcher.router.setDomainVerbosity(domain, options.verbosity);
  const records: Record<string, unknown> = {
    'agent-aaaa1111': { id: 'agent-aaaa1111', template: 'engineer', task: 'Cap the retry delay', status: 'completed', startedAt: 0, completedAt: 12_000, toolCallCount: 4 },
    'agent-bbbb2222': { id: 'agent-bbbb2222', template: 'reviewer', task: 'Review the retry change', status: 'failed', startedAt: 0, completedAt: 9_000, toolCallCount: 2 },
  };
  const registerSdkLines = () => registerHostRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => router,
    requestRender: () => {},
    configManager: { get: () => 9 } as never,
    agentManager: { getStatus: (id: string) => records[id], listByCohort: () => [], list: () => [] } as never,
    wrfcController: { getChain: () => null, listChains: () => [] } as never,
  });
  // Both listener orders happen in the app (registration order differs by composition).
  if (options.bridgeFirst) { wireRuntimeNotificationBridge(bus, dispatcher); registerSdkLines(); }
  else { registerSdkLines(); wireRuntimeNotificationBridge(bus, dispatcher); }
  return { bus, feed, toasts, conversation };
}

async function emitRun(bus: RuntimeEventBus): Promise<void> {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_CREATED', { type: 'WORKFLOW_CHAIN_CREATED', chainId: 'wrfc-1234567890ab', task: 'Cap the retry delay' } as never, { ...ctx, traceId: 't0' }));
  bus.emit('workflows', createEventEnvelope('WORKFLOW_REVIEW_COMPLETED', { type: 'WORKFLOW_REVIEW_COMPLETED', chainId: 'wrfc-1234567890ab', score: 10, passed: true } as never, { ...ctx, traceId: 't0r' }));
  bus.emit('workflows', createEventEnvelope('WORKFLOW_GATE_RESULT', { type: 'WORKFLOW_GATE_RESULT', chainId: 'wrfc-1234567890ab', gate: 'typecheck', passed: true } as never, { ...ctx, traceId: 't0g' }));
  bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: 'agent-aaaa1111', durationMs: 12_000 } as never, { ...ctx, traceId: 't1' }));
  bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-bbbb2222', error: 'the provider refused the request', durationMs: 9_000 } as never, { ...ctx, traceId: 't2' }));
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_PASSED', { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'wrfc-1234567890ab' } as never, { ...ctx, traceId: 't3' }));
  bus.emit('workflows', createEventEnvelope('WORKFLOW_AUTO_COMMITTED', { type: 'WORKFLOW_AUTO_COMMITTED', chainId: 'wrfc-1234567890ab', commitHash: 'abcdef0123456789' } as never, { ...ctx, traceId: 't4' }));
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_FAILED', { type: 'WORKFLOW_CHAIN_FAILED', chainId: 'wrfc-ffff00001111', reason: 'a hook refused the commit' } as never, { ...ctx, traceId: 't5' }));
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

const EXPECTED_TITLES = ['Review chain started', 'Review passed', 'Quality check passed', 'Agent finished', 'Agent failed', 'Review chain passed', 'Reviewed changes committed', 'Review chain failed'];

describe('one notification-history entry per chain or agent event', () => {
  for (const bridgeFirst of [true, false]) {
    for (const verbosity of ['minimal', 'normal'] as const) {
      test(`eight events are eight entries under plain titles (${bridgeFirst ? 'bridge' : 'line'} first, ${verbosity} verbosity)`, async () => {
        const { bus, feed, toasts } = shell({ bridgeFirst, verbosity });
        await emitRun(bus);
        const entries = [...feed.list()].reverse();
        expect(entries.map((entry) => entry.title)).toEqual(EXPECTED_TITLES);
        for (const entry of entries) expect(entry.title.startsWith('[')).toBe(false);
        // The detail is kept: which agent and what it did, the failure reason, the commit.
        expect(entries[3]!.body).toContain('engineer aaaa1111: "Cap the retry delay"');
        expect(entries[4]!.body).toContain('the provider refused the request');
        expect(entries[6]!.body).toContain('abcdef0');
        expect(entries[7]!.body).toContain('a hook refused the commit');
        // Each event toasts once.
        expect(toasts.visible().length).toBeLessThanOrEqual(3);
        const titles = toasts.visible().map((toast) => toast.title);
        expect(new Set(titles).size).toBe(titles.length);
      });
    }
  }

  test('a restored session shows its agent and chain lines under their plain titles, one each', () => {
    const feed = new NotificationFeed();
    const conversation = new ConversationManager(() => 100);
    conversation.setNoticeSink(createShellNoticeSink(feed));
    conversation.fromJSON({ messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '[WRFC] ✓ Chain wrfc-1234567890ab PASSED — all gates clear' },
      { role: 'system', content: '[Agents] ✓ engineer aaaa1111: "Cap the retry delay" — completed in 12s (4 tool calls)' },
    ] });
    expect(feed.list().map((entry) => entry.title).sort()).toEqual(['Agent finished', 'Review chain passed']);
    expect(feed.unreadCount()).toBe(0);
  });

  test('a folded quiet entry toasts once when the conversation line arrives', () => {
    const feed = new NotificationFeed();
    const toasts = new ToastCenter(() => 0, () => {});
    bridgeNotificationFeedToToasts(feed, toasts);
    feed.record({ id: 'n1', domain: 'workflows', level: 'info', title: 'Review chain passed', timestamp: 1 }, { target: 'panel_only', reasonCode: 'allowed' }, 'WORKFLOW_CHAIN_PASSED:wrfc-1234567');
    expect(toasts.visible()).toHaveLength(0);
    feed.recordNotice({ domain: 'wrfc', level: 'info', title: 'Review chain passed', body: 'Chain wrfc-1234567 PASSED', timestamp: 2, eventKey: 'WORKFLOW_CHAIN_PASSED:wrfc-1234567' });
    feed.recordNotice({ domain: 'wrfc', level: 'info', title: 'Review chain passed', body: 'Chain wrfc-1234567 PASSED', timestamp: 3, eventKey: 'WORKFLOW_CHAIN_PASSED:wrfc-1234567' });
    expect(feed.list()).toHaveLength(1);
    expect(toasts.visible().map((toast) => toast.title)).toEqual(['Review chain passed']);
  });

  test('a passed chain whose commit hook refused shows the refusal in its one entry, in the hook\'s words', async () => {
    const { bus, feed, toasts } = shell({ bridgeFirst: true, verbosity: 'minimal' });
    const note = "your repository's commit hooks refused the chain's commit, so nothing was committed and your files were not changed; the chain's work is kept on branch wrfc/1234567890ab. git commit said: lint: name the cap first";
    bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_PASSED', { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'wrfc-1234567890ab', note } as never, { ...ctx, traceId: 'tn' }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const entries = feed.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Review chain passed');
    expect(entries[0]!.body).toContain('git commit said: lint: name the cap first');
    expect(toasts.visible().map((toast) => toast.body ?? '').join('\n')).toContain('lint: name the cap first');
  });
});
