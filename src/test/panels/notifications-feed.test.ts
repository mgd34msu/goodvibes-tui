import { describe, expect, test } from 'bun:test';
import type { Notification } from '@/runtime/index.ts';
import { PanelNotificationFeed } from '../../panels/notifications-feed.ts';

let seq = 0;
function makeNotification(overrides: Partial<Notification> & Pick<Notification, 'domain' | 'level'>): Notification {
  return {
    id: `n-${++seq}`,
    title: `Test ${overrides.level} from ${overrides.domain}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('PanelNotificationFeed', () => {
  test('drops notifications not targeted at panel_only', () => {
    const feed = new PanelNotificationFeed();
    feed.record(makeNotification({ domain: 'tools', level: 'critical' }), { target: 'conversation', reasonCode: 'allowed' });
    expect(feed.list()).toHaveLength(0);
  });

  test('keeps a standalone panel_only notification as its own entry', () => {
    const feed = new PanelNotificationFeed();
    const n = makeNotification({ domain: 'tools', level: 'info', title: 'Wrote 3 files' });
    feed.record(n, { target: 'panel_only', reasonCode: 'allowed' });
    const [entry] = feed.list();
    expect(entry?.title).toBe('Wrote 3 files');
    expect(entry?.collapsedCount).toBe(1);
  });

  test('folds repeated burst_collapsed notifications sharing a batchKey into one entry with a real running count', () => {
    const feed = new PanelNotificationFeed();
    for (let i = 0; i < 5; i += 1) {
      feed.record(
        makeNotification({ domain: 'tools', level: 'info', title: `Progress update ${i}` }),
        { target: 'panel_only', reasonCode: 'burst_collapsed', batchKey: 'tools:info' },
      );
    }
    const entries = feed.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.collapsedCount).toBe(5);
    // The count is the true accumulated count, not an estimate, the last
    // title folded in is retained so the entry still says something concrete.
    expect(entries[0]?.title).toBe('Progress update 4');
  });

  test('notifies subscribers on every record()', () => {
    const feed = new PanelNotificationFeed();
    let calls = 0;
    const unsub = feed.subscribe(() => { calls += 1; });
    feed.record(makeNotification({ domain: 'agents', level: 'warning' }), { target: 'panel_only', reasonCode: 'allowed' });
    expect(calls).toBe(1);
    unsub();
    feed.record(makeNotification({ domain: 'agents', level: 'warning' }), { target: 'panel_only', reasonCode: 'allowed' });
    expect(calls).toBe(1);
  });

  test('dismiss removes one entry (a collapsed group goes as a whole) and notifies', () => {
    const feed = new PanelNotificationFeed();
    for (let i = 0; i < 3; i += 1) {
      feed.record(makeNotification({ domain: 'tools', level: 'info' }), { target: 'panel_only', reasonCode: 'burst_collapsed', batchKey: 'tools:info' });
    }
    feed.record(makeNotification({ domain: 'agents', level: 'warning', title: 'keep me' }), { target: 'panel_only', reasonCode: 'allowed' });
    let calls = 0;
    feed.subscribe(() => { calls += 1; });
    const group = feed.list().find((e) => e.collapsedCount === 3)!;
    expect(feed.dismiss(group.key)).toBe(true);
    expect(feed.list().map((e) => e.title)).toEqual(['keep me']);
    expect(calls).toBe(1);
    expect(feed.dismiss('no-such-key')).toBe(false);
  });

  test('subject: the notification\'s own panelId or jump action, else one from its domain', () => {
    const feed = new PanelNotificationFeed();
    feed.record(makeNotification({ domain: 'tools', level: 'info', title: 'own', panelId: 'git' }), { target: 'panel_only', reasonCode: 'allowed' });
    feed.record(makeNotification({ domain: 'tools', level: 'info', title: 'jump', action: { label: 'Open', type: 'jump_to_panel', panelId: 'cost' } }), { target: 'panel_only', reasonCode: 'allowed' });
    feed.record(makeNotification({ domain: 'agents', level: 'info', title: 'agent' }), { target: 'panel_only', reasonCode: 'allowed' });
    feed.record(makeNotification({ domain: 'deliveries', level: 'info', title: 'none' }), { target: 'panel_only', reasonCode: 'allowed' });
    const byTitle = new Map(feed.list().map((e) => [e.title, e.subject]));
    expect(byTitle.get('own')).toBe('git');
    expect(byTitle.get('jump')).toBe('cost');
    expect(byTitle.get('agent')).toBe('agents');
    expect(byTitle.get('none')).toBeUndefined();
  });

  test('unread counts entries newer than the last look; markAllSeen clears it', () => {
    const feed = new PanelNotificationFeed();
    feed.record(makeNotification({ domain: 'agents', level: 'warning', timestamp: 1_000 }), { target: 'panel_only', reasonCode: 'allowed' });
    feed.record(makeNotification({ domain: 'agents', level: 'info', timestamp: 2_000 }), { target: 'panel_only', reasonCode: 'allowed' });
    expect(feed.unreadCount()).toBe(2);
    feed.markAllSeen();
    expect(feed.unreadCount()).toBe(0);
    feed.record(makeNotification({ domain: 'agents', level: 'info', timestamp: 3_000 }), { target: 'panel_only', reasonCode: 'allowed' });
    expect(feed.unreadCount()).toBe(1);
    expect(feed.isUnread(feed.list()[0]!)).toBe(true);
  });
});
