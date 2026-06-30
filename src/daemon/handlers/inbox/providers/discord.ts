// ---------------------------------------------------------------------------
// Discord inbound adapter.
//
// Transport note (contract fidelity): the daemon-handoff checklist names the
// Discord Gateway for DM polling. The Gateway is a persistent websocket push
// transport and cannot be driven by the inbound poller, whose contract is a
// stateless, cadence-driven adapter.poll() that MUST resolve each call (see
// provider-adapter.ts) — a long-lived socket the poller neither owns nor
// supervises is out of scope for that contract. We therefore satisfy the
// DM-polling goal over Discord's supported request/response surface, the REST
// API — the same DM data the Gateway streams, fetched on the poll cadence and
// paged so a busy DM is never truncated:
//   GET /users/@me/channels        -> list DM channels the bot participates in
//   GET /channels/{id}/messages    -> recent messages per DM channel (paged via
//                                   the `before` snowflake cursor)
//
// Discord snowflake ids encode their creation timestamp, so receivedAt is
// derived from the message id (snowflake) when no explicit timestamp is present.
//
// Credential: surfaces.discord.botToken. Missing => 'unavailable'.
// Cadence: 30s (realtime tier).
// ---------------------------------------------------------------------------

import type {
  AdapterContext,
  InboundChannelItem,
  InboundProviderAdapter,
  ProviderPollOptions,
  ProviderPollResult,
} from '../provider-adapter.ts';
import { POLL_CADENCE_MS } from '../provider-adapter.ts';
import { digestSender, toBodyPreview, toSubjectPreview } from '../mapping.ts';
import { resolveRouteId } from './route-util.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const DISCORD_API = 'https://discord.com/api/v10';
// Discord epoch (2015-01-01T00:00:00Z) in ms, used to decode snowflakes.
const DISCORD_EPOCH_MS = 1_420_070_400_000;
export const DISCORD_PROVIDER_ID = 'discord';
export const DISCORD_CREDENTIAL_KEY = 'surfaces.discord.botToken';

interface DiscordChannel {
  id: string;
  type: number; // 1 = DM, 3 = group DM
}

interface DiscordSelf {
  id: string;
}

interface DiscordReaction {
  count?: number;
  emoji?: { id?: string | null; name?: string | null };
}

interface DiscordMessage {
  id: string;
  channel_id?: string;
  content?: string;
  timestamp?: string; // ISO-8601
  author?: { id: string; bot?: boolean };
  referenced_message?: unknown;
  mentions?: Array<{ id: string }>;
  reactions?: DiscordReaction[];
}

/**
 * Classify a Discord message into the InboundChannelItem `kind`.
 *   - reaction: someone reacted to OUR OWN message — a genuine inbound reaction
 *               event. Requires the message to be authored by us (its author id
 *               is selfId) AND to carry a non-empty reactions[]. A message
 *               authored by someone else that merely carries reactions[] is a
 *               normal DM, not a reaction event.
 *   - mention:  the message mentions us (our id is in mentions[])
 *   - thread:   the message is a reply (referenced_message present)
 *   - dm:       a plain direct message
 * Reaction outranks mention which outranks thread/dm (most-specific first).
 */
function classifyDiscordKind(
  msg: DiscordMessage,
  selfId: string | undefined,
): InboundChannelItem['kind'] {
  if (
    selfId &&
    msg.author?.id === selfId &&
    Array.isArray(msg.reactions) &&
    msg.reactions.length > 0
  ) {
    return 'reaction';
  }
  if (selfId && Array.isArray(msg.mentions) && msg.mentions.some((m) => m.id === selfId)) {
    return 'mention';
  }
  if (msg.referenced_message) return 'thread';
  return 'dm';
}

/** Decode a Discord snowflake id to its creation Unix-ms timestamp. */
function snowflakeToMs(id: string): number {
  try {
    const asBig = BigInt(id);
    return Number((asBig >> 22n)) + DISCORD_EPOCH_MS;
  } catch {
    return 0;
  }
}

async function discordGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${token}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 401) throw new Error('Discord authentication failed (401)');
  if (!res.ok) throw new Error(`Discord GET ${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function createDiscordAdapter(ctx: AdapterContext): InboundProviderAdapter {
  return {
    id: DISCORD_PROVIDER_ID,
    pollIntervalMs: POLL_CADENCE_MS.realtime,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let token: string | null;
      try {
        token = await ctx.credentials.resolveConfigSecret(DISCORD_CREDENTIAL_KEY);
      } catch (error) {
        return unavailable(`credential lookup failed: ${errMsg(error)}`);
      }
      if (!token || token.trim().length === 0) {
        return unavailable('missing surfaces.discord.botToken');
      }

      // Resolve our own user id so we can classify @-mentions of us. Best-effort:
      // a failure only disables mention classification, never the provider.
      let selfId: string | undefined;
      try {
        const self = await discordGet<DiscordSelf>(token, '/users/@me');
        if (self.id) selfId = self.id;
      } catch (error) {
        ctx.logger.warn('discord /users/@me failed; mentions will not be classified', {
          error: errMsg(error),
        });
      }

      try {
        const channels = await discordGet<DiscordChannel[]>(token, '/users/@me/channels');
        const dmChannels = channels.filter((c) => c.type === 1 || c.type === 3);
        const items: InboundChannelItem[] = [];
        // /channels/{id}/messages returns at most `perChannel` (<=50) messages
        // newest-first. A DM that accrued more than one page of new messages in
        // the `since` window would silently drop the oldest beyond the first page
        // unless we page backwards via the `before` cursor (the id of the oldest
        // message seen so far). MAX_HISTORY_PAGES bounds the walk.
        const MAX_HISTORY_PAGES = 20;
        const perChannel = Math.min(opts.limit, 50);
        channelLoop: for (const channel of dmChannels) {
          if (items.length >= opts.limit) break;
          let before: string | undefined;
          for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
            const params = new URLSearchParams({ limit: String(perChannel) });
            // Discord treats after/before/around as mutually exclusive: sending
            // both silently drops older in-window messages. Use `after` only on
            // the first page (to bound the window at `since`); once paging
            // backwards via `before`, drop `after` and rely on the
            // oldestMs<=since stop condition below to terminate the walk.
            if (before) params.set('before', before);
            else if (opts.since) params.set('after', msToSnowflake(opts.since));
            let messages: DiscordMessage[];
            try {
              messages = await discordGet<DiscordMessage[]>(
                token,
                `/channels/${channel.id}/messages?${params.toString()}`,
              );
            } catch (error) {
              ctx.logger.warn('discord channel messages failed', {
                channel: channel.id,
                error: errMsg(error),
              });
              continue channelLoop;
            }
            if (messages.length === 0) break;
            // Track the oldest id on this page for the next `before` cursor before
            // we filter/skip, so pagination is driven by the raw page, not by what
            // survived classification.
            let oldestId: string | undefined;
            let oldestMs = Number.POSITIVE_INFINITY;
            for (const msg of messages) {
              const msgMs = msg.timestamp
                ? Date.parse(msg.timestamp) || snowflakeToMs(msg.id)
                : snowflakeToMs(msg.id);
              if (msgMs < oldestMs) {
                oldestMs = msgMs;
                oldestId = msg.id;
              }
              if (items.length >= opts.limit) break;
              if (msg.author?.bot) continue;
              const receivedAt = msgMs;
              if (opts.since && receivedAt <= opts.since) continue;
              const senderId = msg.author?.id ?? channel.id;
              // Contract: fromDigest is SHA-256 (first 16 hex == 8 bytes) of the
              // provider user id. Discord user ids (snowflakes) are globally
              // unique, and the item.id / provider fields already namespace by
              // provider.
              const fromDigest = digestSender(senderId);
              const kind = classifyDiscordKind(msg, selfId);
              const item: InboundChannelItem = {
                id: `discord:${channel.id}:${msg.id}`,
                provider: DISCORD_PROVIDER_ID,
                kind,
                fromDigest,
                subjectPreview: toSubjectPreview('Direct message'),
                bodyPreview: toBodyPreview(msg.content),
                receivedAt,
                unread: true,
              };
              const routeId = await resolveRouteId(ctx, DISCORD_PROVIDER_ID, fromDigest, kind);
              if (routeId) item.routeId = routeId;
              items.push(item);
            }
            // Stop paging this channel when the page was not full (no older
            // messages exist), the item budget is spent, or the oldest message on
            // this page is already at/older than the `since` floor.
            if (messages.length < perChannel || items.length >= opts.limit) break;
            if (opts.since && oldestMs <= opts.since) break;
            if (!oldestId) break;
            before = oldestId;
          }
        }
        return { items, state: items.length > 0 ? 'ready' : 'empty' };
      } catch (error) {
        return unavailable(errMsg(error));
      }
    },
  };
}

/** Build a synthetic snowflake from a Unix-ms timestamp for the `after` cursor. */
function msToSnowflake(ms: number): string {
  const delta = Math.max(0, Math.floor(ms) - DISCORD_EPOCH_MS);
  return (BigInt(delta) << 22n).toString();
}

function unavailable(error: string): ProviderPollResult {
  return { items: [], state: 'unavailable', error };
}

function errMsg(error: unknown): string {
  return summarizeError(error);
}
