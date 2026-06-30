// ---------------------------------------------------------------------------
// Slack inbound adapter.
//
// Transport note (contract fidelity): the daemon-handoff checklist names the
// Slack Events API / RTM for DM polling. Those are push transports (HTTP event
// callbacks / a persistent websocket) and cannot be driven by the inbound
// poller, whose contract is a stateless, cadence-driven adapter.poll() that
// MUST resolve each call (see provider-adapter.ts). A websocket/event-callback
// would require an inbound HTTP endpoint or a long-lived socket the poller
// neither owns nor supervises. We therefore satisfy the DM-polling goal over
// the supported request/response surface (the Slack Web API), which the Events
// API itself documents as the canonical pull-based equivalent for reading DM
// history on an interval:
//   conversations.list (types=im)  -> open DM channels (cursor-paginated)
//   conversations.history          -> recent messages per DM
//   auth.test                      -> our own user id (for @-mention class.);
//                                     id is digested, never emitted raw.
//
// Credential: surfaces.slack.botToken. Missing => 'unavailable'.
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

const SLACK_API = 'https://slack.com/api';
export const SLACK_PROVIDER_ID = 'slack';
export const SLACK_CREDENTIAL_KEY = 'surfaces.slack.botToken';

interface SlackConversationsListResponse {
  ok: boolean;
  error?: string;
  channels?: Array<{ id: string; user?: string }>;
  response_metadata?: { next_cursor?: string };
}

interface SlackAuthTestResponse {
  ok: boolean;
  error?: string;
  user_id?: string;
}

interface SlackReaction {
  name?: string;
  count?: number;
  users?: string[];
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string; // "1700000000.000200"
  thread_ts?: string;
  reactions?: SlackReaction[];
}

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/**
 * Classify a Slack message into the InboundChannelItem `kind`.
 *   - reaction: someone reacted to OUR OWN message — a genuine inbound reaction
 *               event. Requires the message to be authored by us (its user id
 *               is selfUserId) AND to carry a non-empty reactions[]. A message
 *               authored by someone else that merely carries reactions[] is a
 *               normal DM, not a reaction event.
 *   - mention:  the message @-mentions us (text contains `<@SELF>`)
 *   - thread:   a threaded reply (thread_ts present and not the root ts)
 *   - dm:       a plain direct message
 * Reaction outranks mention which outranks thread/dm (most-specific first).
 */
function classifySlackKind(
  msg: SlackMessage,
  selfUserId: string | undefined,
): InboundChannelItem['kind'] {
  if (
    selfUserId &&
    msg.user === selfUserId &&
    Array.isArray(msg.reactions) &&
    msg.reactions.length > 0
  ) {
    return 'reaction';
  }
  if (selfUserId && typeof msg.text === 'string' && msg.text.includes(`<@${selfUserId}>`)) {
    return 'mention';
  }
  if (msg.thread_ts && msg.thread_ts !== msg.ts) return 'thread';
  return 'dm';
}

/** Slack ts ("1700000000.000200") -> Unix ms. */
function tsToMs(ts: string | undefined): number {
  if (!ts) return 0;
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

async function slackGet<T>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Slack ${method} HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function createSlackAdapter(ctx: AdapterContext): InboundProviderAdapter {
  return {
    id: SLACK_PROVIDER_ID,
    pollIntervalMs: POLL_CADENCE_MS.realtime,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let token: string | null;
      try {
        token = await ctx.credentials.resolveConfigSecret(SLACK_CREDENTIAL_KEY);
      } catch (error) {
        return unavailable(`credential lookup failed: ${errMsg(error)}`);
      }
      if (!token || token.trim().length === 0) {
        return unavailable('missing surfaces.slack.botToken');
      }
      if (!token.startsWith('xoxb-') && !token.startsWith('xoxp-')) {
        return unavailable('surfaces.slack.botToken is not a valid Slack bot/user token');
      }

      // Resolve our own user id so we can distinguish @-mentions of us from
      // plain DMs. Best-effort: a failure here only means mentions are not
      // separately classified, it never fails the provider.
      let selfUserId: string | undefined;
      try {
        const auth = await slackGet<SlackAuthTestResponse>(token, 'auth.test', {});
        if (auth.ok && auth.user_id) selfUserId = auth.user_id;
      } catch (error) {
        ctx.logger.warn('slack auth.test failed; mentions will not be classified', {
          error: errMsg(error),
        });
      }

      try {
        // Page through ALL open DM channels. conversations.list returns at most
        // `limit` channels per page and a response_metadata.next_cursor when more
        // remain; without following the cursor, accounts with >100 open DMs would
        // silently lose every channel past the first page. MAX_LIST_PAGES bounds
        // the loop so a misbehaving cursor can never spin forever.
        const MAX_LIST_PAGES = 50;
        const channels: Array<{ id: string; user?: string }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
          const list = await slackGet<SlackConversationsListResponse>(token, 'conversations.list', {
            types: 'im',
            limit: '100',
            ...(cursor ? { cursor } : {}),
          });
          if (!list.ok) {
            return unavailable(`conversations.list: ${list.error ?? 'unknown_error'}`);
          }
          if (list.channels) channels.push(...list.channels);
          const next = list.response_metadata?.next_cursor;
          if (!next || next.length === 0) break;
          cursor = next;
        }
        const oldest = opts.since ? (opts.since / 1000).toFixed(6) : undefined;
        // Page through conversations.history per channel: a single call returns at
        // most `limit` (<=50) messages and sets has_more + a next_cursor when a DM
        // accrued more new messages than fit in one page. Without following the
        // cursor a busy DM would silently drop everything past the first page.
        // MAX_HISTORY_PAGES bounds the loop so a misbehaving cursor cannot spin.
        const MAX_HISTORY_PAGES = 20;
        const items: InboundChannelItem[] = [];
        channelLoop: for (const channel of channels) {
          if (items.length >= opts.limit) break;
          let historyCursor: string | undefined;
          for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
            const history = await slackGet<SlackHistoryResponse>(token, 'conversations.history', {
              channel: channel.id,
              limit: String(Math.min(opts.limit, 50)),
              ...(oldest ? { oldest } : {}),
              ...(historyCursor ? { cursor: historyCursor } : {}),
            });
            if (!history.ok) {
              // Skip this DM but keep going; do not fail the whole provider.
              ctx.logger.warn('slack conversations.history failed', {
                channel: channel.id,
                error: history.error,
              });
              continue channelLoop;
            }
            for (const msg of history.messages ?? []) {
              if (items.length >= opts.limit) break;
              if (msg.subtype === 'bot_message' || msg.bot_id) continue;
              const senderId = msg.user ?? channel.user ?? channel.id;
              const receivedAt = tsToMs(msg.ts);
              if (opts.since && receivedAt <= opts.since) continue;
              // Contract: fromDigest is SHA-256 (first 16 hex == 8 bytes) of the
              // provider user id. Slack user ids (U...) are unique within a
              // workspace, and the item.id / provider fields already namespace
              // by provider.
              const fromDigest = digestSender(senderId);
              const kind = classifySlackKind(msg, selfUserId);
              const item: InboundChannelItem = {
                id: `slack:${channel.id}:${msg.ts ?? String(receivedAt)}`,
                provider: SLACK_PROVIDER_ID,
                kind,
                fromDigest,
                subjectPreview: toSubjectPreview(`Direct message`),
                bodyPreview: toBodyPreview(msg.text),
                receivedAt,
                unread: true,
              };
              const routeId = await resolveRouteId(ctx, SLACK_PROVIDER_ID, fromDigest, kind);
              if (routeId) item.routeId = routeId;
              items.push(item);
            }
            // Advance to the next history page only while the channel reported
            // more messages AND we still have item budget left.
            const nextHistory = history.response_metadata?.next_cursor;
            if (!history.has_more || !nextHistory || nextHistory.length === 0) break;
            if (items.length >= opts.limit) break;
            historyCursor = nextHistory;
          }
        }
        return { items, state: items.length > 0 ? 'ready' : 'empty' };
      } catch (error) {
        return unavailable(errMsg(error));
      }
    },
  };
}

function unavailable(error: string): ProviderPollResult {
  return { items: [], state: 'unavailable', error };
}

function errMsg(error: unknown): string {
  return summarizeError(error);
}
