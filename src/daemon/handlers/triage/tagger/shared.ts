// ---------------------------------------------------------------------------
// Triage tagger — shared types and provider-agnostic helpers.
//
// Provider config shapes, the apply request/result contract, and the tag
// normalization helpers used by the IMAP/Slack/Discord modules. No I/O here.
// ---------------------------------------------------------------------------

import type { InboundChannelItem, TriageLabel } from '../types.ts';

export interface TaggerProviderConfig {
  /** IMAP host:port (default port 993, TLS). Credentials resolved separately. */
  imap?: { host: string; port?: number; user: string; passwordConfigKey: string; mailbox?: string };
  /** Slack bot token config key (resolved from credential store). */
  slack?: { tokenConfigKey: string };
  /**
   * Discord bot token config key (resolved from credential store), plus an
   * optional forum-tag mapping. When `forumTagIds` maps a GoodVibes triage tag
   * (e.g. 'GoodVibes/Spam') to a forum tag SNOWFLAKE id, items that target a
   * forum/media-channel thread get that REAL thread tag applied (PATCH
   * applied_tags) — exact fidelity to the contract's "Discord thread tags".
   * Without a mapping (or for non-thread messages) tagging degrades to a
   * unicode reaction analog.
   */
  discord?: { tokenConfigKey: string; forumTagIds?: Record<string, string> };
}

export interface ApplyTagsRequest {
  item: InboundChannelItem;
  /** Provider-side tags to apply. Defaults to [labelToTag(label)] when omitted. */
  tags?: readonly string[];
  label?: TriageLabel;
  /** Must be true — provider-side mutation requires explicit confirmation. */
  confirm?: boolean;
  /** Mirror of the operator invocation context flag. */
  explicitUserRequest?: boolean;
}

export interface ApplyTagsResult {
  surface: string;
  itemId: string;
  appliedTags: string[];
  /** True when the autotag flag is disabled or no provider matched. */
  skipped: boolean;
  reason?: string;
}

/** IMAP keywords cannot contain spaces or '/'; normalize the canonical tag. */
export function imapKeywordForTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_]+/g, '_');
}

export function slackEmojiForTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.includes('spam')) return 'no_entry_sign';
  if (lower.includes('priority')) return 'rotating_light';
  return 'inbox_tray';
}

export function discordEmojiForTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.includes('spam')) return '\u{1F6AB}';
  if (lower.includes('priority')) return '\u{1F6A8}';
  return '\u{1F4E5}';
}

/** Read a non-empty string from the item's opaque metadata bag. */
export function stringMeta(item: InboundChannelItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
