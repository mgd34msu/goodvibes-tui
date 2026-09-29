/**
 * notifications-modal.ts, the notification history (/notifications, ctrl+p
 * "notifications").
 *
 * ↑↓ move, Enter goes to what the notification is about (when it is about
 * something that can be opened), x dismisses the selected one, ctrl+x clears
 * them all. Opening the modal marks everything as seen.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SurfaceModal, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import { renderNotificationsModal, type NotificationsModalView } from '../renderer/notifications-modal.ts';
import type { PanelFeedEntry, PanelNotificationFeed } from '../panels/notifications-feed.ts';

export interface NotificationsModalOptions {
  readonly feed: PanelNotificationFeed;
  /**
   * The opener for the view a notification is about (views.ts resolves the
   * name), or null when nothing holds it.
   */
  readonly resolveSubject: (subject: string) => (() => void) | null;
  /** Clock (tests pass a fixed one). */
  readonly now?: () => number;
}

export class NotificationsModal implements SurfaceModal, NotificationsModalView {
  readonly name = 'notifications';
  selectedIndex = 0;
  status: string | null = null;
  /** Unread when the modal opened (opening marks everything seen). */
  readonly unread: number;
  private readonly unreadKeys: ReadonlySet<string>;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: NotificationsModalOptions) {
    const feed = options.feed;
    this.unread = feed.unreadCount();
    this.unreadKeys = new Set(feed.list().filter((entry) => feed.isUnread(entry)).map((entry) => entry.key));
    feed.markAllSeen();
    this.unsubscribe = feed.subscribe(() => {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.entries.length - 1));
    });
  }

  get entries(): readonly PanelFeedEntry[] {
    return this.options.feed.list();
  }

  get now(): number {
    return (this.options.now ?? Date.now)();
  }

  isUnread = (entry: PanelFeedEntry): boolean => this.unreadKeys.has(entry.key);

  onClose(): void {
    this.unsubscribe();
    this.options.feed.markAllSeen();
  }

  private selected(): PanelFeedEntry | undefined {
    return this.entries[this.selectedIndex];
  }

  private move(delta: number): void {
    const count = this.entries.length;
    if (count === 0) return;
    this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
  }

  private dismissSelected(): void {
    const entry = this.selected();
    if (!entry) return;
    this.options.feed.dismiss(entry.key);
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.entries.length - 1));
    this.status = `Dismissed "${entry.title}".`;
  }

  private goTo(host: SurfaceModalHost): void {
    const entry = this.selected();
    if (!entry) return;
    if (!entry.subject) {
      this.status = 'This notification is not about anything that can be opened.';
      return;
    }
    const open = this.options.resolveSubject(entry.subject);
    if (!open) {
      this.status = `Nothing to open for "${entry.subject}".`;
      return;
    }
    host.close(this, 'done');
    open();
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'text') {
      if (token.value === 'x') this.dismissSelected();
      else if (token.value === 'j') this.move(1);
      else if (token.value === 'k') this.move(-1);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (token.ctrl && key === 'x') {
      const count = this.entries.length;
      this.options.feed.clear();
      this.selectedIndex = 0;
      this.status = count > 0 ? `Cleared ${count} notification${count === 1 ? '' : 's'}.` : null;
      return;
    }
    if (key === 'up') this.move(-1);
    else if (key === 'down') this.move(1);
    else if (key === 'pageup') this.move(-10);
    else if (key === 'pagedown') this.move(10);
    else if (key === 'home') this.selectedIndex = 0;
    else if (key === 'end') this.selectedIndex = Math.max(0, this.entries.length - 1);
    else if (key === 'enter') this.goTo(host);
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderNotificationsModal(this, screenWidth, screenHeight);
  }
}
