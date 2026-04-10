import { describe, expect, test } from 'bun:test';
import { ChannelDeliveryRouter } from '../../channels/index.ts';
import type { ChannelDeliveryRequest } from '../../channels/index.ts';

function serviceRequest(): ChannelDeliveryRequest {
  return {
    target: { kind: 'surface', surfaceKind: 'service', address: 'svc-1' },
    body: 'hello from automation',
    title: 'Automation delivery',
    jobId: 'job-1',
    runId: 'run-1',
    includeLinks: false,
  };
}

describe('ChannelDeliveryRouter', () => {
  test('registers default concrete channel delivery strategies', () => {
    const router = new ChannelDeliveryRouter();

    expect(router.listStrategies().map((strategy) => strategy.id)).toEqual([
      'channel-delivery:webhook',
      'channel-delivery:slack',
      'channel-delivery:discord',
      'channel-delivery:ntfy',
      'channel-delivery:web-control-plane',
    ]);
  });

  test('supports custom delivery strategies without automation owning egress behavior', async () => {
    const router = new ChannelDeliveryRouter({ strategies: [] });
    const delivered: ChannelDeliveryRequest[] = [];

    expect(router.listStrategies()).toHaveLength(0);
    await expect(router.deliver(serviceRequest())).rejects.toThrow('Unsupported channel delivery target: surface:service');

    router.registerStrategy({
      id: 'channel-delivery:test-service',
      canHandle(request) {
        return request.target.surfaceKind === 'service';
      },
      async deliver(request) {
        delivered.push(request);
        return { responseId: `service:${request.target.address}` };
      },
    });

    expect(await router.deliver(serviceRequest())).toBe('service:svc-1');
    expect(delivered[0]?.jobId).toBe('job-1');
    expect(delivered[0]?.runId).toBe('run-1');
  });

  test('guards strategy id collisions unless replacement is explicit', () => {
    const router = new ChannelDeliveryRouter({ strategies: [] });
    const strategy = {
      id: 'channel-delivery:test',
      canHandle: () => false,
      async deliver() {
        return {};
      },
    };

    router.registerStrategy(strategy);

    expect(() => router.registerStrategy(strategy)).toThrow('Channel delivery strategy already registered');
    expect(() => router.registerStrategy({ ...strategy, canHandle: () => true }, { replace: true })).not.toThrow();
    expect(router.listStrategies()).toHaveLength(1);
  });

  test('rejects unsafe webhook delivery targets before dispatch', async () => {
    const router = new ChannelDeliveryRouter();

    await expect(router.deliver({
      target: { kind: 'webhook', address: 'https://127.0.0.1/callback' },
      body: 'do not deliver to local network',
      title: 'Unsafe delivery',
      jobId: 'job-unsafe',
      runId: 'run-unsafe',
      includeLinks: false,
    })).rejects.toThrow('Webhook URL host is not allowed');
  });
});
