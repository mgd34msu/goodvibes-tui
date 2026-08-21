import { describe, expect, test } from 'bun:test';
import { NotificationRouter } from '@/runtime/index.ts';
import type { Notification } from '@/runtime/index.ts';
import { PanelNotificationFeed } from '../../panels/notifications-feed.ts';
import { NotificationsPanel } from '../../panels/notifications-panel.ts';
import { linesToText } from '../setup.ts';

let seq = 0;
function makeNotification(overrides: Partial<Notification> & Pick<Notification, 'domain' | 'level'>): Notification {
  return {
    id: `n-${++seq}`,
    title: `Test ${overrides.level} from ${overrides.domain}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

function renderText(panel: NotificationsPanel, width = 80, height = 24): string {
  return linesToText(panel.render(width, height)).join('\n');
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
});

describe('NotificationsPanel: render', () => {
  test('empty state names the target honestly when nothing has routed here yet', () => {
    const panel = new NotificationsPanel(new PanelNotificationFeed());
    const text = renderText(panel);
    expect(text).toContain('No panel-routed notifications yet');
  });

  test('a standalone panel_only notification renders with its full title text, never clipped', () => {
    const feed = new PanelNotificationFeed();
    const longTitle = 'Compaction reduced the transcript from 128,000 tokens to 41,000 tokens while preserving every open task and the last three tool results in full';
    feed.record(
      makeNotification({ domain: 'session', level: 'info', title: longTitle }),
      { target: 'panel_only', reasonCode: 'allowed' },
    );
    const panel = new NotificationsPanel(feed);
    for (const width of [80, 60]) {
      const text = renderText(panel, width).replace(/\s+/g, ' ');
      expect(text).toContain(longTitle);
    }
  });

  test('a burst-collapsed group renders visibly with its real collapsed count and reason', () => {
    const router = new NotificationRouter(2_000, true, { windowMs: 1_000, threshold: 3 });
    const feed = new PanelNotificationFeed();
    const domain = 'tools';
    const level = 'info' as const;
    const now = Date.now();
    let lastNotification: Notification | null = null;
    for (let i = 0; i < 10; i += 1) {
      const n = makeNotification({ domain, level, title: `Progress ${i}`, timestamp: now + i });
      const decision = router.route(n);
      if (decision.reasonCode === 'burst_collapsed') {
        feed.record(n, decision);
        lastNotification = n;
      }
    }
    expect(lastNotification).not.toBeNull();

    const panel = new NotificationsPanel(feed);
    const text = renderText(panel).replace(/\s+/g, ' ');
    // 10 fired, first 3 pass (below threshold), the rest (7) are collapsed.
    expect(text).toContain('×7');
    expect(text).toContain('7 notifications collapsed');
    expect(text).toContain('rapid repeats collapsed');
    expect(text).toContain(domain);
  });

  test('scrolling does not crash with a single entry and reports no scroll consumed', () => {
    const feed = new PanelNotificationFeed();
    feed.record(makeNotification({ domain: 'git', level: 'warning' }), { target: 'panel_only', reasonCode: 'allowed' });
    const panel = new NotificationsPanel(feed);
    panel.render(80, 24);
    expect(panel.handleInput?.('down')).toBe(false);
  });
});
