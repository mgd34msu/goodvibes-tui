/**
 * Tests for the SQLite-backed cursor + item store: dedup by id, monotonic
 * cursor advancement, and feed queries.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxCursorStore } from '../../../daemon/handlers/inbox/cursor-store.ts';
import type { InboundChannelItem } from '../../../daemon/handlers/inbox/provider-adapter.ts';

function item(over: Partial<InboundChannelItem> & { id: string }): InboundChannelItem {
  return {
    provider: 'slack',
    kind: 'dm',
    fromDigest: '0123456789abcdef',
    subjectPreview: 'Direct message',
    bodyPreview: 'hello',
    receivedAt: 1_000,
    unread: true,
    ...over,
  };
}

let dir: string;
let store: InboxCursorStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inbox-cursor-'));
  store = new InboxCursorStore(dir);
  await store.init();
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('InboxCursorStore', () => {
  test('upsertItems dedups by id and counts only new items', () => {
    expect(store.upsertItems([item({ id: 'a' }), item({ id: 'b' })])).toBe(2);
    // Re-inserting 'a' plus a new 'c' => only 'c' is new.
    expect(store.upsertItems([item({ id: 'a' }), item({ id: 'c' })])).toBe(1);
    expect(store.countItems()).toBe(3);
  });

  test('upsertItems counts a duplicate id within one batch once', () => {
    // A single poll can return the same id twice; it must yield one row and
    // count as one new item, not over-report the new-item total.
    expect(store.upsertItems([item({ id: 'dup' }), item({ id: 'dup' })])).toBe(1);
    expect(store.countItems()).toBe(1);
  });

  test('advanceCursor is monotonic', () => {
    store.advanceCursor('slack', 500);
    expect(store.getCursor('slack')).toBe(500);
    store.advanceCursor('slack', 300); // lower => ignored
    expect(store.getCursor('slack')).toBe(500);
    store.advanceCursor('slack', 900);
    expect(store.getCursor('slack')).toBe(900);
  });

  test('listItems filters by provider and since, newest first', () => {
    store.upsertItems([
      item({ id: 's1', provider: 'slack', receivedAt: 100 }),
      item({ id: 's2', provider: 'slack', receivedAt: 300 }),
      item({ id: 'd1', provider: 'discord', receivedAt: 200 }),
    ]);
    const slack = store.listItems({ providers: ['slack'], limit: 10 });
    expect(slack.map((i) => i.id)).toEqual(['s2', 's1']);
    const recent = store.listItems({ since: 150, limit: 10 });
    expect(recent.map((i) => i.id).sort()).toEqual(['d1', 's2']);
  });

  test('limit caps the returned window', () => {
    store.upsertItems([
      item({ id: 'a', receivedAt: 1 }),
      item({ id: 'b', receivedAt: 2 }),
      item({ id: 'c', receivedAt: 3 }),
    ]);
    expect(store.listItems({ limit: 2 })).toHaveLength(2);
  });

  test('maxReceivedAt reflects the newest item', () => {
    store.upsertItems([item({ id: 'a', receivedAt: 10 }), item({ id: 'b', receivedAt: 42 })]);
    expect(store.maxReceivedAt()).toBe(42);
    expect(store.maxReceivedAt(['discord'])).toBe(0);
  });

  test('upsert updates mutable feed fields on conflict', () => {
    store.upsertItems([item({ id: 'a', receivedAt: 10 })]);
    // Re-upsert the same id with updated feed fields.
    store.upsertItems([item({ id: 'a', receivedAt: 20, unread: false })]);
    const [row] = store.listItems({ limit: 1 });
    expect(row!.receivedAt).toBe(20);
    expect(row!.unread).toBe(false);
  });

  test('advanceCursor ignores a non-finite candidate', () => {
    store.advanceCursor('slack', 400);
    store.advanceCursor('slack', Number.NaN); // guarded => no change
    store.advanceCursor('slack', Number.POSITIVE_INFINITY); // guarded => no change
    expect(store.getCursor('slack')).toBe(400);
  });

  test('advanceCursor writes through a first zero candidate', async () => {
    // current===0 + candidate 0 hits the `current !== 0` arm of the guard, so
    // it must NOT early-return: a genuine 0 watermark row is persisted once.
    store.advanceCursor('discord', 0);
    expect(store.getCursor('discord')).toBe(0);
    // Reopen proves a row was actually written (not just the unset-default 0).
    await store.flush();
    await store.close();
    const reopened = new InboxCursorStore(dir);
    await reopened.init();
    try {
      expect(reopened.getCursor('discord')).toBe(0);
      // A later real watermark still advances from the persisted zero.
      reopened.advanceCursor('discord', 250);
      expect(reopened.getCursor('discord')).toBe(250);
    } finally {
      await reopened.close();
    }
  });

  test('pruneOlderThan removes old items, keeps cursors, and is provider-scoped', () => {
    store.upsertItems([
      item({ id: 'old', provider: 'slack', receivedAt: 100 }),
      item({ id: 'new', provider: 'slack', receivedAt: 500 }),
      item({ id: 'dold', provider: 'discord', receivedAt: 50 }),
    ]);
    store.advanceCursor('slack', 500);
    // Provider-scoped: only slack items older than 200 are removed.
    expect(store.pruneOlderThan(200, ['slack'])).toBe(1);
    expect(store.listItems({ limit: 10 }).map((i) => i.id).sort()).toEqual([
      'dold',
      'new',
    ]);
    // Cursor is untouched by retention.
    expect(store.getCursor('slack')).toBe(500);
    // Unscoped prune sweeps the rest below the cutoff.
    expect(store.pruneOlderThan(100)).toBe(1);
    expect(store.countItems()).toBe(1);
  });

  test('pruneOlderThan is a no-op for a non-finite cutoff', () => {
    store.upsertItems([item({ id: 'a', receivedAt: 10 })]);
    expect(store.pruneOlderThan(Number.NaN)).toBe(0);
    expect(store.countItems()).toBe(1);
  });

  test('survives a flush + reopen round trip', async () => {
    store.upsertItems([item({ id: 'persist', receivedAt: 7 })]);
    store.advanceCursor('slack', 7);
    await store.flush();
    await store.close();
    const reopened = new InboxCursorStore(dir);
    await reopened.init();
    try {
      expect(reopened.countItems()).toBe(1);
      expect(reopened.getCursor('slack')).toBe(7);
    } finally {
      await reopened.close();
    }
  });
});
