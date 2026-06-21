// ---------------------------------------------------------------------------
// Triage tagger — Slack provider.
//
// Applies a triage label as a Slack message reaction (reactions.add). The bot
// token is resolved per-apply from the daemon credential store and is never
// logged or returned. `already_reacted` is treated as idempotent success.
// ---------------------------------------------------------------------------

import type { HandlerContext } from '../../context.ts';
import type { DaemonCredentialStore } from '../../credentials.ts';
import { HandlerError } from '../../errors.ts';
import type { InboundChannelItem } from '../types.ts';
import type { ApplyTagsResult, TaggerProviderConfig } from './shared.ts';
import { slackEmojiForTag, stringMeta } from './shared.ts';

export async function applySlack(
  item: InboundChannelItem,
  tags: string[],
  providers: TaggerProviderConfig,
  credentials: DaemonCredentialStore,
  fetchImpl: typeof fetch,
  ctx: HandlerContext,
  base: ApplyTagsResult,
): Promise<ApplyTagsResult> {
  const cfg = providers.slack;
  if (!cfg) return { ...base, reason: 'slack-not-configured' };
  const channel = stringMeta(item, 'channelId') ?? item.conversationId;
  const ts = stringMeta(item, 'ts') ?? stringMeta(item, 'messageTs');
  if (!channel || !ts) return { ...base, reason: 'slack-missing-target' };
  if (tags.length === 0) return { ...base, reason: 'no-tags' };

  const token = await credentials.resolveConfigSecret(cfg.tokenConfigKey);
  if (!token) return { ...base, reason: 'slack-no-credentials' };

  const applied: string[] = [];
  for (const tag of tags) {
    const emoji = slackEmojiForTag(tag);
    const response = await fetchImpl('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new HandlerError(
        `Slack reactions.add HTTP ${response.status}`,
        'TRIAGE_SLACK_TAG_FAILED',
        502,
      );
    }
    // 'already_reacted' is an idempotent success for our purposes.
    if (payload.ok !== true && payload.error !== 'already_reacted') {
      ctx.logger.warn('triage: slack reaction rejected', { error: payload.error });
      throw new HandlerError(
        `Slack reactions.add rejected: ${payload.error ?? 'unknown'}`,
        'TRIAGE_SLACK_TAG_FAILED',
        502,
      );
    }
    applied.push(tag);
  }
  return { surface: item.surface, itemId: item.id, appliedTags: applied, skipped: false };
}
