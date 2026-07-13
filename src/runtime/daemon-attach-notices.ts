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
import { FeatureAnnouncementStore, featureAnnouncementsPath, createSandboxContainmentAnnouncer } from '@pellux/goodvibes-sdk/platform/runtime/feature-announcements';
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

/** Milliseconds an external-daemon receipts read waits before giving up. */
const EXTERNAL_RECEIPTS_TIMEOUT_MS = 1500;

export interface ExternalDaemonAttachNoticesDeps {
  /** The adopted daemon's base URL, e.g. "http://127.0.0.1:3421". */
  readonly baseUrl: string;
  /** The shared bearer the adopted daemon authenticates (the companion-pairing token). */
  readonly authToken: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable timeout (ms); defaults to EXTERNAL_RECEIPTS_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * Consume — exactly once — a separately-hosted (external/systemd) daemon's
 * undelivered receipts AND drained announcements over HTTP, returning the
 * one-line notices to render. The default deployment adopts such a daemon with
 * no in-process handle (daemonServer is null), so the embedded in-process fold
 * sees nothing; this hits the daemon's own consuming endpoint instead —
 * GET <baseUrl>/status?receipts=consume with the shared bearer. The daemon
 * marks the served receipts delivered as it responds (its own exactly-once
 * store), so a second attach with nothing new returns []. Any transport, auth,
 * or parse failure yields no notices rather than throwing into the attach path.
 */
export async function consumeExternalDaemonAttachNotices(
  deps: ExternalDaemonAttachNoticesDeps,
): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? EXTERNAL_RECEIPTS_TIMEOUT_MS);
  try {
    const headers = new Headers();
    if (deps.authToken.trim()) headers.set('Authorization', `Bearer ${deps.authToken.trim()}`);
    const url = `${deps.baseUrl.replace(/\/+$/, '')}/status?receipts=consume`;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) return [];
    const body = (await response.json()) as { receipts?: unknown } | null;
    const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
    const notices: string[] = [];
    for (const entry of receipts) {
      if (entry && typeof (entry as { text?: unknown }).text === 'string') {
        const text = (entry as { text: string }).text;
        if (text.trim().length > 0) notices.push(text);
      }
    }
    return notices;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The "commands now run contained" first-run announcer for the sandboxed exec
 * path. Returns the callback registerAllTools calls on each contained run: the
 * FIRST call records the announce-once line (so any later attach-time consume
 * also sees it) and surfaces it now via `notify`; every later run is silent.
 */
export function createSandboxContainmentNotice(deps: {
  readonly configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>;
  readonly notify: (text: string) => void;
}): () => void {
  const store = new FeatureAnnouncementStore(featureAnnouncementsPath(deps.configManager));
  return createSandboxContainmentAnnouncer(store, (announcement) => deps.notify(announcement.text));
}
