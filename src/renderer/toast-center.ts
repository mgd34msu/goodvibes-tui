/**
 * toast-center.ts, the toast primitive's state.
 *
 * A toast appears in the top right corner (drawn by renderToasts in
 * surface-kit-parts.ts: a colored ┃ on both sides, the title bold, the body
 * wrapped in full) and disappears after five seconds. Newest first; at most
 * three are kept, older ones leave early rather than stacking down the screen.
 *
 * Producers: commandContext.showToast (any command), and the shared
 * notification feed, whose warning and critical entries also toast
 * (bridgeNotificationFeedToToasts). Informational notifications stay in the
 * feed only, so toasts keep meaning "this needs your eyes".
 */

import type { PanelFeedEntry, PanelNotificationFeed } from '../panels/notifications-feed.ts';
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

function toneForLevel(level: PanelFeedEntry['level']): ToastTone | null {
  if (level === 'critical') return 'error';
  if (level === 'warning') return 'warning';
  return null;
}

/**
 * Toast every new warning or critical entry of the notification feed. A
 * collapsed burst toasts once per growth of its running count, with the count
 * in the title. Returns an unsubscribe function.
 */
export function bridgeNotificationFeedToToasts(feed: PanelNotificationFeed, toasts: ToastCenter): () => void {
  const seen = new Map<string, number>();
  for (const entry of feed.list()) seen.set(entry.key, entry.collapsedCount);
  return feed.subscribe(() => {
    for (const entry of feed.list()) {
      if (seen.get(entry.key) === entry.collapsedCount) continue;
      seen.set(entry.key, entry.collapsedCount);
      const tone = toneForLevel(entry.level);
      if (!tone) continue;
      const title = entry.collapsedCount > 1 ? `${entry.title} (${entry.collapsedCount} times)` : entry.title;
      toasts.show({ title, body: entry.body, tone });
    }
  });
}
