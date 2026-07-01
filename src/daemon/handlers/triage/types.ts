// ---------------------------------------------------------------------------
// Daemon-internal triage domain types.
//
// `InboundChannelItem` is the daemon-internal shape the inbox poller produces
// and the triage pipeline scores. It is NOT an SDK catalog contract: the
// published `channels.inbox.list` output schema (CHANNEL_INBOX_ITEM_SCHEMA) is
// owned by the SDK and never re-declared here. This is the internal poller
// item per the handoff doc — it carries `fromDigest` (never a raw sender id),
// `subjectPreview`/`bodyPreview` (PII-stripped, length-bounded) and an opaque
// `metadata` bag the tagger reads provider targeting from (imapUid, channelId,
// Slack ts, Discord messageId/threadId).
// ---------------------------------------------------------------------------

/** Triage label assigned by the scorer. */
export type TriageLabel = 'spam' | 'priority' | 'normal';

/** 1:1 vs group/channel/thread conversation hint (priority signal). */
export type ConversationKind = 'direct' | 'group' | 'channel' | 'thread' | 'service';

/**
 * Internal inbound feed item. Mirrors the handoff `InboundChannelItem` shape
 * plus the optional fields the scorer/tagger consult. `surface` is the provider
 * family ('email' | 'imap' | 'slack' | 'discord' | ...) the tagger dispatches
 * on; `provider` is the handoff-facing provider id. They are usually equal.
 */
export interface InboundChannelItem {
  /** Stable, provider-scoped dedup key. */
  readonly id: string;
  /** Provider family the tagger dispatches on (email/imap/slack/discord/...). */
  readonly surface: string;
  /** Handoff-facing provider id ("slack" | "discord" | "email" | ...). */
  readonly provider?: string;
  readonly kind?: 'dm' | 'thread' | 'mention' | 'reaction';
  /** SHA-256 first-N of sender external id — NEVER a raw identifier. */
  readonly fromDigest?: string;
  /** Conversation id (Slack/Discord channel, IMAP mailbox-scoped). */
  readonly conversationId?: string;
  readonly conversationKind?: ConversationKind;
  /** Display subject (<= 200 chars). */
  readonly subject?: string;
  /** Display body preview (<= 500 chars, PII-stripped). Alias: bodyPreview. */
  readonly snippet?: string;
  /** Optional daemon route binding id. */
  readonly routeId?: string;
  /** Unix ms. */
  readonly receivedAt?: number;
  readonly unread?: boolean;
  /** Opaque provider targeting bag (imapUid/uid, channelId, ts, messageId, threadId). */
  readonly metadata?: Record<string, unknown>;
}
