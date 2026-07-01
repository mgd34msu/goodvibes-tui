/**
 * Tests for the inbound poller: dedup persistence, monotonic cursor handoff to
 * adapters, resilience to a rejecting adapter, and 'unavailable' state capture.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxCursorStore } from '../../../daemon/handlers/inbox/cursor-store.ts';
import { InboundPoller } from '../../../daemon/handlers/inbox/poller.ts';
import type {
  InboundChannelItem,
  InboundProviderAdapter,
  ProviderPollOptions,
  ProviderPollResult,
} from '../../../daemon/handlers/inbox/provider-adapter.ts';

const logger = {
  info() {},
  warn() {},
  error() {},
};

function mkItem(id: string, receivedAt: number): InboundChannelItem {
  return {
    id,
    provider: 'fake',
    kind: 'dm',
    fromDigest: 'abcdef0123456789',
    subjectPreview: 'Direct message',
    bodyPreview: 'body',
    receivedAt,
    unread: true,
  };
}

/** Adapter that records the `since` it was polled with and returns scripted results. */
class ScriptedAdapter implements InboundProviderAdapter {
  readonly id = 'fake';
  readonly pollIntervalMs = 30_000;
  readonly seenSince: Array<number | undefined> = [];
  private readonly script: ProviderPollResult[];
  private call = 0;

  constructor(script: ProviderPollResult[]) {
    this.script = script;
  }

  poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
    this.seenSince.push(opts.since);
    const result = this.script[Math.min(this.call, this.script.length - 1)]!;
    this.call += 1;
    return Promise.resolve(result);
  }
}

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

describe('InboundPoller', () => {
  test('persists items, advances cursor, and reports ready', async () => {
    const adapter = new ScriptedAdapter([
      { state: 'ready', items: [mkItem('a', 100), mkItem('b', 250)] },
    ]);
    const poller = new InboundPoller({
      adapters: new Map([['fake', adapter]]),
      store,
      logger,
    });
    await poller.pollOnce();
    expect(store.countItems()).toBe(2);
    expect(store.getCursor('fake')).toBe(250);
    const [status] = poller.snapshotStatuses();
    expect(status!.state).toBe('ready');
    expect(status!.itemCount).toBe(2);
  });

  test('passes the persisted cursor back as `since` on the next poll', async () => {
    const adapter = new ScriptedAdapter([
      { state: 'ready', items: [mkItem('a', 500)] },
      { state: 'empty', items: [] },
    ]);
    const poller = new InboundPoller({
      adapters: new Map([['fake', adapter]]),
      store,
      logger,
    });
    await poller.pollOnce();
    await poller.pollOnce();
    expect(adapter.seenSince[0]).toBeUndefined();
    expect(adapter.seenSince[1]).toBe(500);
  });

  test('captures an unavailable adapter without crashing', async () => {
    const adapter = new ScriptedAdapter([
      { state: 'unavailable', items: [], error: 'missing credentials' },
    ]);
    const poller = new InboundPoller({
      adapters: new Map([['fake', adapter]]),
      store,
      logger,
    });
    await poller.pollOnce();
    const [status] = poller.snapshotStatuses();
    expect(status!.state).toBe('unavailable');
    expect(status!.error).toBe('missing credentials');
    expect(store.countItems()).toBe(0);
  });

  test('a rejecting adapter is downgraded to unavailable, never propagates', async () => {
    const throwing: InboundProviderAdapter = {
      id: 'boom',
      pollIntervalMs: 30_000,
      poll() {
        return Promise.reject(new Error('socket exploded'));
      },
    };
    const poller = new InboundPoller({
      adapters: new Map([['boom', throwing]]),
      store,
      logger,
    });
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    const [status] = poller.snapshotStatuses();
    expect(status!.state).toBe('unavailable');
    expect(status!.error).toContain('socket exploded');
  });
});
