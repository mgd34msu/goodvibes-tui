/**
 * Tests for the SQLite-backed cursor + item store: dedup by id, monotonic
 * cursor advancement, and feed queries.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboxCursorStore,
  type InboxSweepSummary,
} from '../../../daemon/handlers/inbox/cursor-store.ts';
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
    // A recent receivedAt: reopening runs the retention sweep, and a 1970-era
    // timestamp would (correctly) be reclaimed by the age TTL.
    const recent = Date.now() - 1_000;
    store.upsertItems([item({ id: 'persist', receivedAt: recent })]);
    store.advanceCursor('slack', recent);
    await store.flush();
    await store.close();
    const reopened = new InboxCursorStore(dir);
    await reopened.init();
    try {
      expect(reopened.countItems()).toBe(1);
      expect(reopened.getCursor('slack')).toBe(recent);
    } finally {
      await reopened.close();
    }
  });
});

describe('InboxCursorStore retention', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('the age TTL sweep runs at init and reclaims stale rows', async () => {
    const now = Date.now();
    store.upsertItems([
      item({ id: 'stale', receivedAt: now - 40 * DAY_MS }),
      item({ id: 'recent', receivedAt: now - 1 * DAY_MS }),
    ]);
    store.advanceCursor('slack', now);
    await store.flush();
    await store.close();

    const sweeps: InboxSweepSummary[] = [];
    const reopened = new InboxCursorStore(dir, undefined, {
      onSweep: (summary) => sweeps.push(summary),
    });
    await reopened.init();
    try {
      expect(reopened.listItems({ limit: 10 }).map((i) => i.id)).toEqual(['recent']);
      // Disclosure carries the right counts.
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]).toMatchObject({ expired: 1, capped: 0, remaining: 1 });
      // Cursors are monotonic watermarks and are never reaped.
      expect(reopened.getCursor('slack')).toBe(now);
    } finally {
      await reopened.close();
    }
  });

  test('the count cap keeps the newest rows and drops the rest', async () => {
    const now = Date.now();
    const capped = new InboxCursorStore(dir, 'cap.sqlite', { itemCap: 3 });
    await capped.init();
    try {
      capped.upsertItems([
        item({ id: 'i0', receivedAt: now - 5_000 }),
        item({ id: 'i1', receivedAt: now - 4_000 }),
        item({ id: 'i2', receivedAt: now - 3_000 }),
        item({ id: 'i3', receivedAt: now - 2_000 }),
        item({ id: 'i4', receivedAt: now - 1_000 }),
      ]);
      const summary = capped.sweepRetention();
      expect(summary).toMatchObject({ expired: 0, capped: 2, remaining: 3 });
      expect(capped.listItems({ limit: 10 }).map((i) => i.id)).toEqual(['i4', 'i3', 'i2']);
    } finally {
      await capped.close();
    }
  });

  test('sweeping twice reclaims nothing the second time', async () => {
    const now = Date.now();
    const swept = new InboxCursorStore(dir, 'idempotent.sqlite', { itemCap: 2 });
    await swept.init();
    try {
      swept.upsertItems([
        item({ id: 'a', receivedAt: now - 40 * DAY_MS }),
        item({ id: 'b', receivedAt: now - 3_000 }),
        item({ id: 'c', receivedAt: now - 2_000 }),
        item({ id: 'd', receivedAt: now - 1_000 }),
      ]);
      const first = swept.sweepRetention();
      expect(first).toMatchObject({ expired: 1, capped: 1, remaining: 2 });
      const second = swept.sweepRetention();
      expect(second).toMatchObject({ expired: 0, capped: 0, remaining: 2 });
      expect(swept.listItems({ limit: 10 }).map((i) => i.id)).toEqual(['d', 'c']);
    } finally {
      await swept.close();
    }
  });

  test('the sweep keeps running on a timer, not only at startup', async () => {
    const now = Date.now();
    let tick: (() => void) | null = null;
    const sweeps: InboxSweepSummary[] = [];
    const timed = new InboxCursorStore(dir, 'timed.sqlite', {
      itemCap: 1,
      sweepIntervalMs: 1_000,
      onSweep: (summary) => sweeps.push(summary),
      setIntervalImpl: ((fn: () => void) => {
        tick = fn;
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    await timed.init();
    try {
      // Nothing to reclaim at init, so the timer is what must catch this.
      expect(sweeps).toHaveLength(0);
      timed.upsertItems([
        item({ id: 'x', receivedAt: now - 2_000 }),
        item({ id: 'y', receivedAt: now - 1_000 }),
      ]);
      expect(tick).not.toBeNull();
      tick!();
      // The timer callback is async (it flushes), so wait for the sweep it
      // produces rather than sleeping a fixed 20 ms and hoping. 20 ms is a
      // number only an idle machine can promise for a flush that touches the
      // database; under a concurrent load this read `Expected length: 1 /
      // Received length: 0` while the sweep was simply still in flight. The
      // poll returns the moment the sweep is recorded, so a fast host pays
      // nothing, and a sweep that never happens still fails.
      const sweepDeadline = Date.now() + 30_000;
      while (sweeps.length === 0) {
        if (Date.now() > sweepDeadline) {
          throw new Error('the retention timer never produced a sweep within 30000ms');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(timed.countItems()).toBe(1);
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]).toMatchObject({ capped: 1, remaining: 1 });
    } finally {
      await timed.close();
    }
  });

  test('a sweep over an empty table discloses nothing', async () => {
    const sweeps: InboxSweepSummary[] = [];
    const quiet = new InboxCursorStore(dir, 'quiet.sqlite', {
      onSweep: (summary) => sweeps.push(summary),
    });
    await quiet.init();
    try {
      expect(sweeps).toHaveLength(0);
      expect(quiet.sweepRetention()).toMatchObject({ expired: 0, capped: 0, remaining: 0 });
    } finally {
      await quiet.close();
    }
  });

  test('a store closed while init() is still in flight never arms the retention timer', async () => {
    // registerInboxMethods() starts init() without awaiting it, so a daemon
    // told to stop inside the first tick of its life closes the store while its
    // bootstrap is mid-await. init() then reached startSweepTimer() AFTER the
    // only call that could clear it had already run, and the sweep ticked for
    // the life of the process with no owner left to stop it.
    const armed: number[] = [];
    const cleared: number[] = [];
    const racing = new InboxCursorStore(dir, 'racing.sqlite', {
      sweepIntervalMs: 1_000,
      setIntervalImpl: ((_fn: () => void, ms: number) => {
        armed.push(ms);
        return armed.length as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalImpl: ((handle: number) => {
        cleared.push(handle);
      }) as unknown as typeof clearInterval,
    });

    const booting = racing.init();
    await racing.close();
    await booting;

    expect(armed).toEqual([]);
    expect(cleared).toEqual([]);
  });
});
