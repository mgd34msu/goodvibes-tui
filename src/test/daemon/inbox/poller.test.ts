import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxCursorStore } from '../../../daemon/channels/inbox/cursor-store.ts';
import { InboundPoller } from '../../../daemon/channels/inbox/poller.ts';
import type {
  InboundProviderAdapter,
  ProviderPollOptions,
  ProviderPollResult,
} from '../../../daemon/channels/inbox/provider-adapter.ts';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeAdapter(
  id: string,
  intervalMs: number,
  poll: (opts: ProviderPollOptions) => Promise<ProviderPollResult>,
): InboundProviderAdapter {
  return { id, pollIntervalMs: intervalMs, poll };
}

describe('InboundPoller', () => {
  let dir: string;
  let store: InboxCursorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inbox-poller-'));
    store = new InboxCursorStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('pollOnce persists items, dedups, advances cursor and records ready status', async () => {
    let calls = 0;
    const adapter = fakeAdapter('slack', 30_000, async (opts) => {
      calls += 1;
      expect(opts.limit).toBeGreaterThan(0);
      return {
        state: 'ready',
        items: [
          {
            id: 'slack:1', provider: 'slack', kind: 'dm', fromDigest: 'd1',
            subjectPreview: 's', bodyPreview: 'b', receivedAt: 1000, unread: true,
          },
          {
            id: 'slack:2', provider: 'slack', kind: 'dm', fromDigest: 'd2',
            subjectPreview: 's', bodyPreview: 'b', receivedAt: 2000, unread: true,
          },
        ],
      };
    });
    const poller = new InboundPoller({
      adapters: new Map([['slack', adapter]]),
      store,
      logger: silentLogger,
    });
    await poller.pollOnce();
    expect(calls).toBe(1);
    expect(store.listItems({ limit: 50 })).toHaveLength(2);
    expect(store.getCursor('slack')).toBe(2000);
    const status = poller.snapshotStatuses(['slack'])[0]!;
    expect(status.state).toBe('ready');
    expect(status.itemCount).toBe(2);

    // Second poll with same items => 0 new, cursor stable
    await poller.pollOnce();
    expect(store.listItems({ limit: 50 })).toHaveLength(2);
    expect(poller.snapshotStatuses(['slack'])[0]!.itemCount).toBe(0);
  });

  test('unavailable provider reports error and does not crash the loop', async () => {
    const bad = fakeAdapter('discord', 30_000, async () => ({
      state: 'unavailable',
      items: [],
      error: 'missing surfaces.discord.botToken',
    }));
    const poller = new InboundPoller({
      adapters: new Map([['discord', bad]]),
      store,
      logger: silentLogger,
    });
    await poller.pollOnce();
    const status = poller.snapshotStatuses(['discord'])[0]!;
    expect(status.state).toBe('unavailable');
    expect(status.error).toContain('botToken');
  });

  test('a thrown adapter error is downgraded to unavailable', async () => {
    const throwing = fakeAdapter('email', 60_000, async () => {
      throw new Error('TLS handshake failed');
    });
    const poller = new InboundPoller({
      adapters: new Map([['email', throwing]]),
      store,
      logger: silentLogger,
    });
    await poller.pollOnce();
    const status = poller.snapshotStatuses(['email'])[0]!;
    expect(status.state).toBe('unavailable');
    expect(status.error).toContain('TLS handshake failed');
  });

  test('start schedules a per-provider interval at the adapter cadence and stop clears it', () => {
    const scheduled: Array<{ ms: number }> = [];
    let cleared = 0;
    const fakeSetInterval = ((fn: () => void, ms?: number) => {
      scheduled.push({ ms: ms ?? 0 });
      return { __id: scheduled.length } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const fakeClearInterval = (() => {
      cleared += 1;
    }) as unknown as typeof clearInterval;

    const poller = new InboundPoller({
      adapters: new Map([
        ['slack', fakeAdapter('slack', 30_000, async () => ({ state: 'empty', items: [] }))],
        ['email', fakeAdapter('email', 60_000, async () => ({ state: 'empty', items: [] }))],
      ]),
      store,
      logger: silentLogger,
      setIntervalImpl: fakeSetInterval,
      clearIntervalImpl: fakeClearInterval,
    });
    poller.start();
    poller.start(); // idempotent
    expect(scheduled.map((s) => s.ms).sort((a, b) => a - b)).toEqual([30_000, 60_000]);
    poller.stop();
    expect(cleared).toBe(2);
  });
});
