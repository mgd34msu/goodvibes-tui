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
import { readClientCompatibilityFloor } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

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

/** Milliseconds an external-daemon `/status` read waits before giving up. */
const EXTERNAL_RECEIPTS_TIMEOUT_MS = 1500;

export interface ExternalDaemonAttachReadDeps {
  /** The adopted daemon's base URL, e.g. "http://127.0.0.1:3421". */
  readonly baseUrl: string;
  /** The shared bearer the adopted daemon authenticates (the companion-pairing token). */
  readonly authToken: string;
  /**
   * Ask for the daemon's undelivered receipts on this read. Delivery at the
   * daemon is destructive — served once, to the consuming reader — so only the
   * read that RENDERS them asks. A reconnect read that just refreshes the two
   * build floors leaves this off, and no receipt is eaten before a surface can
   * show it.
   */
  readonly consumeReceipts?: boolean;
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable timeout (ms); defaults to EXTERNAL_RECEIPTS_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** Everything one `/status` read of an adopted daemon tells this terminal. */
export interface ExternalDaemonAttachRead {
  /** True only when the daemon answered with a usable 2xx body. */
  readonly answered: boolean;
  /** Receipt lines to render; empty unless `consumeReceipts` was asked for. */
  readonly notices: string[];
  /**
   * The minimum CLIENT build the daemon announced on the
   * `X-Goodvibes-Client-Floor` response header, or undefined when it announced
   * none (a daemon too old to publish one is not asking for anything).
   */
  readonly clientFloor: string | undefined;
  /** The parsed body, which carries the daemon's own `version`. */
  readonly statusPayload: unknown;
}

/**
 * One `/status` read of a separately-hosted (external/systemd) daemon, carrying
 * the three things attaching to it decides on: its undelivered receipts, the
 * client build floor it publishes, and its own build.
 *
 * The default deployment adopts such a daemon with no in-process handle
 * (daemonServer is null), so the embedded in-process fold sees nothing; this
 * hits the daemon's own endpoint instead — GET <baseUrl>/status with the shared
 * bearer, plus `?receipts=consume` when the caller is going to render them. The
 * daemon marks the served receipts delivered as it responds (its own
 * exactly-once store), so a second attach with nothing new returns no notices.
 * Any transport, auth, or parse failure reads as unanswered rather than
 * throwing into the attach path.
 */
export async function readExternalDaemonAttach(
  deps: ExternalDaemonAttachReadDeps,
): Promise<ExternalDaemonAttachRead> {
  const unanswered: ExternalDaemonAttachRead = {
    answered: false, notices: [], clientFloor: undefined, statusPayload: null,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? EXTERNAL_RECEIPTS_TIMEOUT_MS);
  try {
    const headers = new Headers();
    if (deps.authToken.trim()) headers.set('Authorization', `Bearer ${deps.authToken.trim()}`);
    const url = `${deps.baseUrl.replace(/\/+$/, '')}/status${deps.consumeReceipts ? '?receipts=consume' : ''}`;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) return unanswered;
    const body = (await response.json()) as { receipts?: unknown } | null;
    const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
    const notices: string[] = [];
    for (const entry of receipts) {
      if (entry && typeof (entry as { text?: unknown }).text === 'string') {
        const text = (entry as { text: string }).text;
        if (text.trim().length > 0) notices.push(text);
      }
    }
    return {
      answered: true,
      notices,
      clientFloor: readClientCompatibilityFloor(response.headers),
      statusPayload: body,
    };
  } catch {
    return unanswered;
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
