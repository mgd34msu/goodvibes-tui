// ---------------------------------------------------------------------------
// Triage tagger — Discord provider.
//
// Two paths, in priority order:
//   1. REAL thread tags: when the item targets a forum/media-channel thread and
//      a forum-tag mapping resolves >=1 tag id, PATCH the thread's applied_tags
//      (read-then-merge — never blind overwrite). Exact fidelity to the
//      contract's "Discord thread tags".
//   2. Reaction analog: Discord has no arbitrary per-message tags, so otherwise
//      add a unicode reaction (PUT .../reactions/{emoji}/@me).
//
// The bot token is resolved per-apply from the daemon credential store and is
// never logged or returned.
// ---------------------------------------------------------------------------

import type { HandlerContext } from '../../context.ts';
import type { DaemonCredentialStore } from '../../credentials.ts';
import { HandlerError } from '../../errors.ts';
import type { InboundChannelItem } from '../types.ts';
import type { ApplyTagsResult, TaggerProviderConfig } from './shared.ts';
import { discordEmojiForTag, stringMeta } from './shared.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export async function applyDiscord(
  item: InboundChannelItem,
  tags: string[],
  providers: TaggerProviderConfig,
  credentials: DaemonCredentialStore,
  fetchImpl: typeof fetch,
  ctx: HandlerContext,
  base: ApplyTagsResult,
): Promise<ApplyTagsResult> {
  const cfg = providers.discord;
  if (!cfg) return { ...base, reason: 'discord-not-configured' };
  const channelId = stringMeta(item, 'channelId') ?? item.conversationId;
  const messageId = stringMeta(item, 'messageId') ?? item.id;
  if (!channelId || !messageId) return { ...base, reason: 'discord-missing-target' };
  if (tags.length === 0) return { ...base, reason: 'no-tags' };

  const token = await credentials.resolveConfigSecret(cfg.tokenConfigKey);
  if (!token) return { ...base, reason: 'discord-no-credentials' };

  // Exact-fidelity path: when the item targets a forum/media-channel thread and
  // a forum-tag mapping resolves at least one tag, apply REAL Discord thread
  // tags (PATCH the thread's applied_tags). A forum post's thread id is the
  // thread's own channel id; accept an explicit metadata.threadId or fall back
  // to channelId for that case.
  const threadId = stringMeta(item, 'threadId') ?? channelId;
  const tagIds = resolveDiscordTagIds(tags, cfg.forumTagIds);
  if (tagIds.length > 0) {
    return applyDiscordThreadTags(item, threadId, tags, tagIds, token, fetchImpl, ctx);
  }

  // Analog fallback: Discord has no arbitrary per-message tags, so apply a
  // unicode reaction on the source message instead.
  const applied: string[] = [];
  for (const tag of tags) {
    const emoji = encodeURIComponent(discordEmojiForTag(tag));
    const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`;
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Length': '0',
      },
    });
    // 204 No Content is the success case for adding a reaction.
    if (response.status !== 204 && response.status !== 200) {
      const detail = await response.text().catch(() => '');
      ctx.logger.warn('triage: discord reaction rejected', { status: response.status });
      throw new HandlerError(
        `Discord reaction HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
        'TRIAGE_DISCORD_TAG_FAILED',
        502,
      );
    }
    applied.push(tag);
  }
  return { surface: item.surface, itemId: item.id, appliedTags: applied, skipped: false };
}

/**
 * Map GoodVibes triage tags to configured Discord forum-tag snowflake ids,
 * preserving order and dropping unmapped tags. De-duplicates ids.
 */
function resolveDiscordTagIds(
  tags: readonly string[],
  forumTagIds: Record<string, string> | undefined,
): string[] {
  if (!forumTagIds) return [];
  const ids: string[] = [];
  for (const tag of tags) {
    const id = forumTagIds[tag];
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Apply real Discord thread tags by merging the resolved forum-tag ids into the
 * thread's existing applied_tags via PATCH /channels/{thread.id}. Idempotent:
 * already-present tag ids are kept and not duplicated.
 */
async function applyDiscordThreadTags(
  item: InboundChannelItem,
  threadId: string,
  tags: readonly string[],
  tagIds: readonly string[],
  token: string,
  fetchImpl: typeof fetch,
  ctx: HandlerContext,
): Promise<ApplyTagsResult> {
  const url = `https://discord.com/api/v10/channels/${threadId}`;
  // DATA-LOSS GUARD: we PATCH the thread's full applied_tags array, so we must
  // first read the EXISTING tags and merge. If that read fails (network error
  // OR a non-ok HTTP status), we have no idea what tags are currently on the
  // thread — PATCHing with only our new ids would silently destroy whatever
  // forum tags were already applied. Abort instead of overwriting.
  const existing = await fetchDiscordAppliedTags(url, token, fetchImpl, ctx);
  if (existing === null) {
    throw new HandlerError(
      'Discord thread tag read failed; aborting to avoid overwriting existing applied_tags.',
      'TRIAGE_DISCORD_TAG_FAILED',
      502,
    );
  }
  const merged = [...new Set([...existing, ...tagIds])];
  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ applied_tags: merged }),
  });
  if (response.status !== 200 && response.status !== 204) {
    const detail = await response.text().catch(() => '');
    ctx.logger.warn('triage: discord thread tag rejected', { status: response.status });
    throw new HandlerError(
      `Discord thread tag HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
      'TRIAGE_DISCORD_TAG_FAILED',
      502,
    );
  }
  return { surface: item.surface, itemId: item.id, appliedTags: [...tags], skipped: false };
}

/**
 * Read a thread's current applied_tags.
 *
 * Returns:
 *   - string[]  -> the read SUCCEEDED; the array is the current applied_tags
 *                  (possibly empty when the thread genuinely has no tags, or
 *                  when applied_tags is absent/malformed in a 2xx body).
 *   - null      -> the read FAILED (thrown error OR non-ok HTTP status). The
 *                  caller MUST NOT proceed with a PATCH in this case, because a
 *                  failed read means the existing tag set is unknown and a
 *                  PATCH would overwrite it (data loss).
 */
async function fetchDiscordAppliedTags(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  ctx: HandlerContext,
): Promise<string[] | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      ctx.logger.warn('triage: discord thread tag read failed', { status: response.status });
      return null;
    }
    const payload = (await response.json().catch(() => null)) as
      | { applied_tags?: unknown }
      | null;
    const current = payload?.applied_tags;
    if (!Array.isArray(current)) return [];
    return current.filter((t): t is string => typeof t === 'string');
  } catch (error) {
    ctx.logger.warn('triage: discord thread tag read errored', {
      message: summarizeError(error),
    });
    return null;
  }
}
