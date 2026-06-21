import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxCursorStore } from '../../../daemon/channels/inbox/cursor-store.ts';
import type { InboundChannelItem } from '../../../daemon/channels/inbox/provider-adapter.ts';

function item(over: Partial<InboundChannelItem> & Pick<InboundChannelItem, 'id'>): InboundChannelItem {
  return {
    provider: 'slack',
    kind: 'dm',
    fromDigest: 'abc123def4567890',
    subjectPreview: 'subject',
    bodyPreview: 'body',
    receivedAt: 1_000,
    unread: true,
    ...over,
  };
}

describe('InboxCursorStore', () => {
  let dir: string;
  let store: InboxCursorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inbox-store-'));
    store = new InboxCursorStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('upsertItems dedups by id and counts only new rows', () => {
    expect(store.upsertItems([item({ id: 'a', receivedAt: 1 }), item({ id: 'b', receivedAt: 2 })])).toBe(2);
    // re-insert same ids => 0 new
    expect(store.upsertItems([item({ id: 'a', receivedAt: 1 }), item({ id: 'b', receivedAt: 2 })])).toBe(0);
    expect(store.upsertItems([item({ id: 'c', receivedAt: 3 })])).toBe(1);
    expect(store.listItems({ limit: 50 })).toHaveLength(3);
  });

  test('listItems orders newest-first, applies since and provider filters and limit', () => {
    store.upsertItems([
      item({ id: 'a', provider: 'slack', receivedAt: 100 }),
      item({ id: 'b', provider: 'discord', receivedAt: 200 }),
      item({ id: 'c', provider: 'slack', receivedAt: 300 }),
    ]);
    const all = store.listItems({ limit: 50 });
    expect(all.map((i) => i.id)).toEqual(['c', 'b', 'a']);

    const slackOnly = store.listItems({ providers: ['slack'], limit: 50 });
    expect(slackOnly.map((i) => i.id)).toEqual(['c', 'a']);

    const sinceFiltered = store.listItems({ since: 150, limit: 50 });
    expect(sinceFiltered.map((i) => i.id)).toEqual(['c', 'b']);

    const limited = store.listItems({ limit: 1 });
    expect(limited.map((i) => i.id)).toEqual(['c']);
  });

  test('advanceCursor is monotonic and never regresses', () => {
    store.advanceCursor('slack', 500);
    expect(store.getCursor('slack')).toBe(500);
    store.advanceCursor('slack', 300); // lower => ignored
    expect(store.getCursor('slack')).toBe(500);
    store.advanceCursor('slack', 900);
    expect(store.getCursor('slack')).toBe(900);
    expect(store.getCursor('unknown')).toBe(0);
  });

  test('maxReceivedAt reflects newest item, optionally per provider', () => {
    store.upsertItems([
      item({ id: 'a', provider: 'slack', receivedAt: 100 }),
      item({ id: 'b', provider: 'discord', receivedAt: 250 }),
    ]);
    expect(store.maxReceivedAt()).toBe(250);
    expect(store.maxReceivedAt(['slack'])).toBe(100);
    expect(store.maxReceivedAt(['email'])).toBe(0);
  });

  test('upsert preserves triage columns written out-of-band by the triage surface', () => {
    store.upsertItems([item({ id: 'a', receivedAt: 100, unread: true })]);
    // Simulate the triage surface writing triage metadata via the typed API.
    store.applyTriage('a', 0.87, ['urgent', 'vip']);
    // Re-poll the same item (now marked read) => triage columns must survive.
    store.upsertItems([item({ id: 'a', receivedAt: 100, unread: false })]);
    const row = store.listItems({ limit: 1 })[0]!;
    expect(row.unread).toBe(false);
    expect(row.triageScore).toBeCloseTo(0.87, 5);
    expect(row.triageTags).toEqual(['urgent', 'vip']);
  });

  test('persists across reopen (flush + reload)', async () => {
    store.upsertItems([item({ id: 'persist-me', receivedAt: 42 })]);
    store.advanceCursor('slack', 42);
    await store.flush();
    await store.close();

    const reopened = new InboxCursorStore(dir);
    await reopened.init();
    try {
      expect(reopened.listItems({ limit: 50 }).map((i) => i.id)).toEqual(['persist-me']);
      expect(reopened.getCursor('slack')).toBe(42);
    } finally {
      await reopened.close();
    }
    // re-create store so afterEach close() is a no-op-safe double close
    store = new InboxCursorStore(dir);
    await store.init();
  });
});
