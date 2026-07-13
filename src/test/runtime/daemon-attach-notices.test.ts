import { describe, expect, test } from 'bun:test';
import { consumeDaemonAttachNotices, type DaemonReceiptLike } from '../../runtime/daemon-attach-notices.ts';

/** A drainable queue that yields its items once, then nothing (exactly-once). */
function drainOnce<T>(items: T[]): () => readonly T[] {
  let drained = false;
  return () => {
    if (drained) return [];
    drained = true;
    return items;
  };
}

const configManager = { getControlPlaneConfigDir: () => '/tmp/gv-does-not-matter' };

describe('consumeDaemonAttachNotices', () => {
  test('renders receipts first, then announcements, as one-line notices', () => {
    const receipts = drainOnce<DaemonReceiptLike>([
      { id: 'r1', text: 'restarted after a crash at 14:32', at: 1 },
      { id: 'r2', text: 'updated to 1.16.2', at: 2 },
    ]);
    const drainAnnouncements = drainOnce([
      { id: 'web-surface-url', text: 'Web surface reachable at http://127.0.0.1:8787', at: 3 },
      { id: 'sandbox-first-run', text: 'commands now run contained; escalations will ask', at: 4 },
    ]);

    const notices = consumeDaemonAttachNotices({
      configManager,
      collectReceipts: receipts,
      announcementStore: { drainPending: drainAnnouncements },
    });

    expect(notices).toEqual([
      'restarted after a crash at 14:32',
      'updated to 1.16.2',
      'Web surface reachable at http://127.0.0.1:8787',
      'commands now run contained; escalations will ask',
    ]);
  });

  test('exactly-once: a second attach with nothing new shows nothing', () => {
    const receipts = drainOnce<DaemonReceiptLike>([{ id: 'r1', text: 'restarted after a crash at 14:32', at: 1 }]);
    const drainAnnouncements = drainOnce([{ id: 'web-surface-url', text: 'Web surface reachable at http://127.0.0.1:8787', at: 2 }]);
    const store = { drainPending: drainAnnouncements };

    const first = consumeDaemonAttachNotices({ configManager, collectReceipts: receipts, announcementStore: store });
    expect(first).toHaveLength(2);

    const second = consumeDaemonAttachNotices({ configManager, collectReceipts: receipts, announcementStore: store });
    expect(second).toEqual([]);
  });

  test('blank receipt/announcement lines are skipped', () => {
    const notices = consumeDaemonAttachNotices({
      configManager,
      collectReceipts: drainOnce<DaemonReceiptLike>([{ id: 'r1', text: '   ', at: 1 }]),
      announcementStore: { drainPending: drainOnce([{ id: 'a1', text: '', at: 2 }]) },
    });
    expect(notices).toEqual([]);
  });
});
