/**
 * renderNotificationsModal, everything the notification feed collected,
 * newest first (replaces the Notifications view).
 *
 *   ✦ Notifications  3 unread                                         esc
 *
 *   ✦ today
 *   ● Daemon restarted after a crash at 15:48                        15:48
 *   ● Control plane is network-reachable with TLS off           ×4 · 21:13
 *
 *   ✦ earlier
 *   ○ Ollama (192.168.0.85): 4 models available                     Sep 27
 *
 *   ⏎ go to   x dismiss   ctrl+x clear all
 *
 * Severity is the dot's color (critical red, warning amber, info blue, debug
 * faint). A collapsed burst shows its true count. A body wraps under its title.
 */

import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock } from './surface-kit-extra.ts';
import type { NotificationFeedEntry } from '../views/notifications-feed.ts';

/** What the renderer reads from the modal. */
export interface NotificationsModalView {
  readonly entries: readonly NotificationFeedEntry[];
  readonly selectedIndex: number;
  readonly unread: number;
  readonly isUnread: (entry: NotificationFeedEntry) => boolean;
  /** A one-line result of the last action, or null. */
  readonly status: string | null;
  /** Clock for the Today/Earlier split (tests pass a fixed value). */
  readonly now: number;
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function whenText(ts: number, now: number): string {
  const d = new Date(ts);
  if (ts >= dayStart(now)) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function dot(entry: NotificationFeedEntry, unread: boolean): { mark: string; fg: string } {
  const t = activeTokens();
  const fg = entry.level === 'critical' ? t.error
    : entry.level === 'warning' ? t.warning
      : entry.level === 'debug' ? t.textFaint
        : t.info;
  return { mark: unread || entry.level === 'critical' || entry.level === 'warning' ? '●' : '○', fg };
}

/** A body's lines as one row description: a list row keeps no line breaks, so lines are joined with a visible separator, never run together. */
export function bodyLine(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join(' \u00b7 ') : undefined;
}

/** Rows in display order, with the entry index each item row stands for (-1 for headers). */
function notificationRows(view: NotificationsModalView): { rows: KitRow[]; entryAt: number[] } {
  const rows: KitRow[] = [];
  const entryAt: number[] = [];
  const today = dayStart(view.now);
  let group: 'Today' | 'Earlier' | null = null;
  view.entries.forEach((entry, i) => {
    const next = entry.timestamp >= today ? 'Today' : 'Earlier';
    if (next !== group) {
      group = next;
      rows.push({ header: next });
      entryAt.push(-1);
    }
    const { mark, fg } = dot(entry, view.isUnread(entry));
    const count = entry.collapsedCount > 1 ? `×${entry.collapsedCount} · ` : '';
    rows.push({
      label: entry.title,
      desc: bodyLine(entry.body),
      right: `${count}${whenText(entry.timestamp, view.now)}`,
      mark,
      markFg: fg,
      selected: i === view.selectedIndex,
    });
    entryAt.push(i);
  });
  return { rows, entryAt };
}

export function renderNotificationsModal(view: NotificationsModalView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const empty = view.entries.length === 0;
  const f = beginModal(screenWidth, screenHeight, {
    title: 'Notifications',
    sub: view.unread > 0 ? `${view.unread} unread` : undefined,
    hints: empty ? [] : [['⏎', 'go to'], ['x', 'dismiss'], ['ctrl+x', 'clear all']],
  });
  const bottom = view.status ? f.bottom - 2 : f.bottom;
  if (empty) {
    drawTextBlock(f.canvas, f.l, f.top, f.r - f.l + 1, [
      { text: 'Nothing here yet.', style: { fg: t.text } },
      { text: 'Agent, task, workflow and security notices collect here as they happen; warnings and critical ones also show as a toast in the top right.', style: { fg: t.textMuted } },
    ], bottom);
  } else {
    const result = drawList(f.canvas, { rows: notificationRows(view).rows, top: f.top, bottom, x0: f.l, x1: f.r, scrollKey: { owner: view, name: 'list' } });
    f.hintRight = scrollCountText(result.above, result.below);
  }
  if (view.status) drawTextBlock(f.canvas, f.l, f.bottom, f.r - f.l + 1, [{ text: view.status, style: { fg: t.textMuted } }], f.bottom);
  return finishModal(f);
}
