/**
 * notices.ts, where a conversation system notice goes.
 *
 * A system notice ([WRFC] …, [Agents] …, a compaction receipt, a failover
 * line) is not part of any turn, so the transcript does not draw it (the
 * concept's turns hold only the turn's own text, beads, lanes and answer;
 * agent and chain state are the lanes' own spawn and merge rows). Each notice
 * becomes a toast in the top right and an entry in the notification history
 * (/notifications), with its full text: the first line is the title, any
 * further lines are the body. The conversation still stores the message, so a
 * saved session keeps it, and restoring that session puts it back in the
 * history without toasting it again.
 *
 * One entry per event: a "[WRFC] …" or "[Agents] …" line that restates an
 * agent or chain event (the SDK's runtimeEventOfNotice names it) is kept under
 * that event's plain title, with the line's detail as the body, and carries
 * the event's key; the terminal's own "[WRFC] …" lines get their plain titles
 * from core/wrfc-notice-titles.ts. The runtime-bus bridge (runtime/notification-dispatch.ts)
 * records the same event with the same key, and the feed keeps one entry for
 * both (NotificationFeed, eventKey).
 */

import type { Notification } from '@/runtime/index.ts';
import { runtimeEventOfNotice } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap';
import { shellChainNoticeOf } from './wrfc-notice-titles.ts';
import type { NotificationFeed } from '../views/notifications-feed.ts';
import { classifySystemMessage } from '../renderer/system-message.ts';

/** Receives every system notice added to (or restored into) the conversation. */
export type NoticeSink = (content: string, options: { readonly restored: boolean }) => void;

/** The pieces of a notice as the history and the toast show them. */
export interface NoticeParts {
  /** Lower-case bracket tag ('wrfc', 'agents', 'compaction', …) or 'system' when untagged. */
  readonly domain: string;
  readonly level: Notification['level'];
  /** The first non-empty line, in full. */
  readonly title: string;
  /** Every further line, in full, or undefined. */
  readonly body: string | undefined;
}

const TAG_RE = /^\s*\[([^\]\n]+)\]/;

export function noticeParts(text: string): NoticeParts {
  const trimmed = text.replace(/^\s*\n+/, '').replace(/\s+$/, '');
  const tag = TAG_RE.exec(trimmed)?.[1];
  const domain = tag ? tag.trim().toLowerCase().replace(/\s+/g, '-') : 'system';
  const kind = classifySystemMessage(trimmed);
  const level: Notification['level'] = kind === 'error' ? 'critical' : kind === 'warning' ? 'warning' : 'info';
  const newline = trimmed.indexOf('\n');
  const title = newline < 0 ? trimmed : trimmed.slice(0, newline);
  const rest = newline < 0 ? '' : trimmed.slice(newline + 1).replace(/^\n+/, '');
  return { domain, level, title, body: rest.length > 0 ? rest : undefined };
}

export interface NoticeOptions {
  /** Restored from a saved session: kept in history, not toasted. */
  readonly restored?: boolean;
  readonly now?: () => number;
}

/** Keep one system notice in the history; the feed's toast bridge toasts it unless restored. */
export function publishNotice(feed: NotificationFeed, text: string, options: NoticeOptions = {}): void {
  if (text.trim().length === 0) return;
  const restored = options.restored === true;
  const parts = noticeParts(text);
  const sdkEvent = runtimeEventOfNotice(text);
  const event = sdkEvent ?? shellChainNoticeOf(text);
  if (event) {
    feed.recordNotice({ domain: parts.domain, level: event.level, title: event.title, body: event.detail, timestamp: (options.now ?? Date.now)(), restored, eventKey: sdkEvent?.key });
    return;
  }
  feed.recordNotice({ ...parts, timestamp: (options.now ?? Date.now)(), restored });
}
