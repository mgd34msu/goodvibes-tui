import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import {
  createNotificationDispatcher,
  wireRuntimeNotificationBridge,
  personFacingEvent,
} from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

// Nothing persisted: every key reads back undefined, so the dispatcher falls
// through to its own defaults.
const fakeConfig = { get: configGetStub() };

describe('notification dispatch: the panel_only producer', () => {
  test('a panel_only decision lands in the feed as a live item', () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(fakeConfig, feed);
    // Minimal verbosity keeps info notifications at the panel_only target.
    dispatcher.router.setDomainVerbosity('agents', 'minimal');

    const decision = dispatcher.dispatch({
      id: 'n1',
      domain: 'agents',
      level: 'info',
      title: 'Agent completed',
      timestamp: 1_000,
    });

    expect(decision.target).toBe('panel_only');
    const items = feed.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Agent completed');
    expect(items[0]!.domain).toBe('agents');
  });

  test('a real runtime event flows through the bus bridge into the notification feed', async () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(fakeConfig, feed);
    dispatcher.router.setDomainVerbosity('agents', 'minimal');
    const bus = new RuntimeEventBus();
    const unsubscribe = wireRuntimeNotificationBridge(bus, dispatcher, ['agents']);

    bus.emit(
      'agents',
      createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED' } as never, { sessionId: 's', traceId: 't1', source: 'test' }),
    );
    // emit() defers each listener to a microtask.
    await Promise.resolve();
    await Promise.resolve();

    const items = feed.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Agent finished');

    unsubscribe();
  });

  test('internal events never enter the history; the person-facing ones keep plain names', async () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(fakeConfig, feed);
    dispatcher.router.setDomainVerbosity('agents', 'minimal');
    dispatcher.router.setDomainVerbosity('workflows', 'minimal');
    const bus = new RuntimeEventBus();
    const unsubscribe = wireRuntimeNotificationBridge(bus, dispatcher, ['agents', 'workflows']);
    const emit = (domain: 'agents' | 'workflows', type: string, payload: Record<string, unknown> = {}, i = 0): void => {
      bus.emit(domain, createEventEnvelope(type as never, { type, ...payload } as never, { sessionId: 's', traceId: `${type}-${i}`, source: 'test' }));
    };

    for (let i = 0; i < 40; i += 1) emit('agents', 'AGENT_STREAM_DELTA', {}, i);
    emit('agents', 'AGENT_PROGRESS');
    emit('agents', 'AGENT_RUNNING');
    emit('workflows', 'WORKFLOW_GATE_RESULT');
    emit('workflows', 'WORKFLOW_STATE_CHANGED');
    emit('agents', 'AGENT_CANCELLED', { reason: 'stopped from the Agents view' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    const items = feed.list();
    const text = items.map((item) => `${item.title} ${item.body ?? ''}`).join('\n');
    expect(text).not.toMatch(/stream delta|gate result|progress|state changed|running/i);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Agent cancelled');
    expect(items[0]!.body).toBe('stopped from the Agents view');

    unsubscribe();
  });

  test('the person-facing table is an allowlist with plain titles', () => {
    expect(personFacingEvent('AGENT_STREAM_DELTA')).toBeUndefined();
    expect(personFacingEvent('WORKFLOW_GATE_RESULT')).toBeUndefined();
    expect(personFacingEvent('toString')).toBeUndefined();
    expect(personFacingEvent('WORKFLOW_CHAIN_PASSED')).toEqual({ title: 'Review chain passed', level: 'info' });
    expect(personFacingEvent('TASK_FAILED')?.level).toBe('warning');
  });
});
