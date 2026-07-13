/**
 * daemon-attach-notices — the attach-time consuming read.
 *
 * On daemon attach a surface reads the daemon's undelivered receipts
 * (update/crash/migration) AND the pending feature-announcement queue
 * (web-surface URL, the sandbox first-contained-run line, …) exactly once,
 * rendering each as a one-line notice. Both sources clear on read — the
 * facade's receipt queue marks its entries delivered, and drainPending() clears
 * the announcement queue — so a second attach with nothing new shows nothing.
 * This mirrors the daemon's own /status?receipts=consume fold, done in-process
 * for the embedded daemon.
 */
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '@pellux/goodvibes-sdk/platform/runtime/feature-announcements';
import type { ConfigManager } from '../config/index.ts';

/** A daemon receipt line (already a human one-liner, e.g. "restarted after a crash at 14:32"). */
export interface DaemonReceiptLike {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/** The minimal announcement-store surface this consume drains. */
export interface DrainableAnnouncementStore {
  drainPending(): readonly { readonly id: string; readonly text: string; readonly at: number }[];
}

export interface DaemonAttachNoticesDeps {
  readonly configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>;
  /** Reads (and marks delivered) the daemon's undelivered receipts. */
  readonly collectReceipts: () => readonly DaemonReceiptLike[];
  /** Injectable announcement store; defaults to the shared control-plane file store. */
  readonly announcementStore?: DrainableAnnouncementStore;
}

/**
 * Consume — exactly once — the daemon's receipts and the pending announcement
 * queue, returning the one-line notices to render. Receipts first (crash /
 * update / migration), then announcements (web-surface URL, sandbox line, …).
 */
export function consumeDaemonAttachNotices(deps: DaemonAttachNoticesDeps): string[] {
  const store = deps.announcementStore
    ?? new FeatureAnnouncementStore(featureAnnouncementsPath(deps.configManager));
  const notices: string[] = [];
  for (const receipt of deps.collectReceipts()) {
    if (receipt.text.trim().length > 0) notices.push(receipt.text);
  }
  for (const announcement of store.drainPending()) {
    if (announcement.text.trim().length > 0) notices.push(announcement.text);
  }
  return notices;
}
