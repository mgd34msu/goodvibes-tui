import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import {
  createNotificationDispatcher,
  wireRuntimeNotificationBridge,
  humanizeEventType,
  levelForEventType,
} from '../../runtime/notification-dispatch.ts';
import { PanelNotificationFeed } from '../../panels/notifications-feed.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';

// Nothing persisted: every key reads back undefined, so the dispatcher falls
// through to its own defaults.
const fakeConfig = { get: configGetStub() };

describe('notification dispatch — the panel_only producer', () => {
  test('a panel_only decision lands in the feed as a live item', () => {
    const feed = new PanelNotificationFeed();
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

  test('a real runtime event flows through the bus bridge into the panel feed', async () => {
    const feed = new PanelNotificationFeed();
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
    expect(items[0]!.title).toBe('Agent completed');

    unsubscribe();
  });

  test('event-type helpers humanize titles and derive severity', () => {
    expect(humanizeEventType('AGENT_COMPLETED')).toBe('Agent completed');
    expect(humanizeEventType('WORKFLOW_CHAIN_PASSED')).toBe('Workflow chain passed');
    expect(levelForEventType('TASK_FAILED')).toBe('warning');
    expect(levelForEventType('AGENT_COMPLETED')).toBe('info');
  });
});

/**
 * The other half of the notification split: panel-feed notices are this
 * surface's, and channel machinery is not.
 *
 * The tests above build the whole panel_only path out of a config stub and a
 * bare event bus — no delivery router, no channel registry, no secrets
 * manager. That is the proof the panel feed needs no daemon furniture, and it
 * is why the second delivery router this composition used to build was so easy
 * to miss: nothing here ever wanted it.
 */
describe('notification dispatch — no second delivery router beside it', () => {
  const services = readFileSync(join(import.meta.dir, '..', '..', 'runtime', 'services.ts'), 'utf8');

  test('the surface exposes the router its delivery manager replies through, not a copy', () => {
    // Two routers built from identical arguments is how a delivery strategy
    // gets registered somewhere replies never leave from — and the exposed one
    // had no reader at all, so nothing failed while they disagreed.
    expect(services).toContain('const channelDeliveryRouter = deliveryManager.getDeliveryRouter();');
    expect(services).not.toContain('new ChannelDeliveryRouter(');
  });

  test('plugin delivery registrations go to that same router', () => {
    const bootstrap = readFileSync(join(import.meta.dir, '..', '..', 'runtime', 'bootstrap.ts'), 'utf8');
    expect(bootstrap).toContain('channelDeliveryRouter: services.deliveryManager.getDeliveryRouter()');
  });
});
