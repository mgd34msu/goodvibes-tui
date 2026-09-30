/**
 * toast-center.ts, the toast primitive's state.
 *
 * A toast appears in the top right corner (drawn by renderToasts in
 * surface-kit-parts.ts: a colored ┃ on both sides, the title bold, the body
 * wrapped in full) and disappears after five seconds. Newest first; at most
 * three are kept, older ones leave early rather than stacking down the screen.
 *
 * Producers: commandContext.showToast (any command), and the shared
 * notification feed (bridgeNotificationFeedToToasts): every conversation
 * system notice toasts ([WRFC] …, [Agents] …, compaction receipts; see
 * core/notices.ts), and of the routed notifications only warning and critical
 * ones do. Everything that toasts stays in the feed, which /notifications
 * shows in full.
 */

import type { NotificationFeedEntry, NotificationFeed } from '../views/notifications-feed.ts';
import type { ToastSpec, ToastTone } from './surface-kit-parts.ts';

/** How long a toast stays up. */
const TOAST_DURATION_MS = 5_000;
/** How many toasts are shown at once. */
const MAX_TOASTS = 3;

interface LiveToast {
  readonly id: number;
  readonly spec: ToastSpec;
  readonly expiresAt: number;
}

export type ToastScheduler = (run: () => void, delayMs: number) => void;

const defaultScheduler: ToastScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  // A pending toast expiry must never keep the process alive on exit.
  (timer as { unref?: () => void }).unref?.();
};

export class ToastCenter {
  private toasts: LiveToast[] = [];
  private nextId = 1;

  /** Called whenever the visible set changes (wired to the render request). */
  onChange: (() => void) | null = null;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly schedule: ToastScheduler = defaultScheduler,
  ) {}

  show(spec: ToastSpec, durationMs: number = TOAST_DURATION_MS): void {
    const toast: LiveToast = { id: this.nextId++, spec, expiresAt: this.clock() + durationMs };
    this.toasts = [toast, ...this.toasts].slice(0, MAX_TOASTS);
    this.schedule(() => this.expire(toast.id), durationMs);
    this.onChange?.();
  }

  /** The toasts to draw now, newest first. */
  visible(): ToastSpec[] {
    const now = this.clock();
    return this.toasts.filter((t) => t.expiresAt > now).map((t) => t.spec);
  }

  clear(): void {
    if (this.toasts.length === 0) return;
    this.toasts = [];
    this.onChange?.();
  }

  private expire(id: number): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    if (this.toasts.length !== before) this.onChange?.();
  }
}

let shared: ToastCenter | null = null;

/** The process-wide toast center (lazily created). */
export function getSharedToastCenter(): ToastCenter {
  shared ??= new ToastCenter();
  return shared;
}

function toneForLevel(level: NotificationFeedEntry['level']): ToastTone | null {
  if (level === 'critical') return 'error';
  if (level === 'warning') return 'warning';
  return null;
}

/** A system notice always toasts; its level picks the bar color. */
function toneForNotice(level: NotificationFeedEntry['level']): ToastTone {
  return toneForLevel(level) ?? 'info';
}

/**
 * Toast every new warning or critical entry of the notification feed. A
 * collapsed burst toasts once per growth of its running count, with the count
 * in the title. Returns an unsubscribe function.
 */
export function bridgeNotificationFeedToToasts(feed: NotificationFeed, toasts: ToastCenter): () => void {
  // Per entry: the count last toasted for, and whether it has toasted at that
  // count. An entry toasts when its count grows, or once when a second arrival
  // of the same event (feed eventKey folding) makes a quiet entry one that
  // toasts; a fold never toasts an entry twice.
  const seen = new Map<string, { readonly count: number; readonly toasted: boolean }>();
  for (const entry of feed.list()) seen.set(entry.key, { count: entry.collapsedCount, toasted: true });
  return feed.subscribe(() => {
    for (const entry of feed.list()) {
      const previous = seen.get(entry.key);
      const tone = entry.toast === 'never' ? null : entry.toast === 'always' ? toneForNotice(entry.level) : toneForLevel(entry.level);
      if (previous && previous.count === entry.collapsedCount && (previous.toasted || !tone)) continue;
      seen.set(entry.key, { count: entry.collapsedCount, toasted: Boolean(tone) });
      if (!tone) continue;
      const title = entry.collapsedCount > 1 ? `${entry.title} (${entry.collapsedCount} times)` : entry.title;
      toasts.show({ title, body: entry.body, tone });
    }
  });
}
