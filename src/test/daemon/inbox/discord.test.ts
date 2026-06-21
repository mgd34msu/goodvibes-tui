import { afterEach, describe, expect, test } from 'bun:test';
import {
  createDiscordAdapter,
  DISCORD_PROVIDER_ID,
  DISCORD_CREDENTIAL_KEY,
} from '../../../daemon/channels/inbox/providers/discord.ts';
import type { AdapterContext } from '../../../daemon/channels/inbox/provider-adapter.ts';
import { digestSender } from '../../../daemon/channels/inbox/mapping.ts';

const silentLogger = { info() {}, warn() {}, error() {} };
const DISCORD_EPOCH_MS = 1_420_070_400_000;

function credsFrom(map: Record<string, string | null>): AdapterContext['credentials'] {
  return {
    async resolveRef(key: string) {
      return map[key] ?? null;
    },
    async resolveConfigSecret(configKey: string) {
      return map[configKey] ?? null;
    },
    async put() {},
    async has(key: string) {
      return Boolean(map[key]);
    },
  };
}

function ctxWith(token: string | null, extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    credentials: credsFrom({ [DISCORD_CREDENTIAL_KEY]: token }),
    logger: silentLogger,
    ...extra,
  };
}

/** Build a real Discord snowflake id for a given Unix-ms creation time. */
function snowflake(ms: number): string {
  return ((BigInt(ms - DISCORD_EPOCH_MS)) << 22n).toString();
}

// ---- fetch stub (dispatch on the request path) ----------------------------
const realFetch = globalThis.fetch;

function installFetch(match: (path: string, url: URL) => { status?: number; body: unknown }): { paths: string[] } {
  const paths: string[] = [];
  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    paths.push(url.pathname + url.search);
    const { status = 200, body } = match(url.pathname, url);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    } as Response;
  }) as typeof fetch;
  return { paths };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('discord adapter', () => {
  test('missing token => unavailable with explicit error', async () => {
    const adapter = createDiscordAdapter(ctxWith(null));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('missing surfaces.discord.botToken');
  });

  test('401 from the API surfaces as unavailable with an auth error', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      return { status: 401, body: {} };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('401');
  });

  test('maps DM messages, skips bot authors, digests sender, derives receivedAt from snowflake', async () => {
    const created = 1_700_000_000_000;
    const msgId = snowflake(created);
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return {
          body: [
            { id: msgId, content: 'hello', author: { id: 'A1' } }, // no timestamp => snowflake decode
            { id: snowflake(created + 1000), content: 'bot', author: { id: 'BOT', bot: true } },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1); // bot author skipped
    const item = result.items[0]!;
    expect(item.id).toBe(`discord:C1:${msgId}`);
    expect(item.provider).toBe(DISCORD_PROVIDER_ID);
    expect(item.fromDigest).toBe(digestSender('A1'));
    expect(item.fromDigest).not.toContain('A1');
    expect(item.kind).toBe('dm');
    // snowflake decoded back to its creation ms
    expect(item.receivedAt).toBe(created);
  });

  test('classifies reply (referenced_message) as thread', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return {
          body: [
            {
              id: snowflake(1_700_000_100_000),
              content: 'a reply',
              author: { id: 'A1' },
              referenced_message: { id: 'X' },
            },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('thread');
  });

  test('classifies @-mention of self via /users/@me id', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return {
          body: [
            {
              id: snowflake(1_700_000_200_000),
              content: 'ping <@SELF>',
              author: { id: 'A1' },
              mentions: [{ id: 'SELF' }],
            },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('mention');
  });

  test('classifies reaction only when SOMEONE REACTED TO OUR OWN message (self-authored + reactions[])', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return {
          body: [
            {
              id: snowflake(1_700_000_300_000),
              content: 'nice',
              author: { id: 'SELF' }, // our own message; someone reacted to it
              reactions: [{ count: 2, emoji: { name: 'fire' } }],
            },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('reaction');
  });

  test('a normal DM authored by SOMEONE ELSE that merely carries reactions[] is a dm, not a reaction', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return {
          body: [
            {
              id: snowflake(1_700_000_310_000),
              content: 'nice',
              author: { id: 'A1' }, // the other party’s message
              reactions: [{ count: 2, emoji: { name: 'fire' } }],
            },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('dm');
  });

  test('since filter passes an after snowflake and drops not-newer messages', async () => {
    const since = 1_700_000_000_000;
    let messagesUrl: URL | undefined;
    installFetch((path, url) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        messagesUrl = url;
        return {
          body: [
            { id: snowflake(since), content: 'old', author: { id: 'A1' }, timestamp: new Date(since).toISOString() },
            { id: snowflake(since + 1000), content: 'new', author: { id: 'A1' }, timestamp: new Date(since + 1000).toISOString() },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10, since });
    // after cursor present in the request
    expect(messagesUrl?.searchParams.get('after')).toBeTruthy();
    // equal-to-since dropped, only the newer one survives
    expect(result.items.map((i) => i.bodyPreview)).toEqual(['new']);
  });

  test('group DMs (type 3) are included; non-DM channel types ignored', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') {
        return { body: [{ id: 'G1', type: 3 }, { id: 'GUILD', type: 0 }] };
      }
      if (path.startsWith('/api/v10/channels/G1/messages')) {
        return { body: [{ id: snowflake(1_700_000_400_000), content: 'group hi', author: { id: 'A1' } }] };
      }
      // GUILD channel must never be fetched
      throw new Error(`unexpected fetch: ${path}`);
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toContain('discord:G1:');
  });

  test('redacts a leaked token in message content end-to-end through toBodyPreview', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return {
          body: [
            {
              id: snowflake(1_700_000_500_000),
              content: 'my token is xoxb-EXAMPLE-discordfake-zzzz please hide it',
              author: { id: 'A1' },
            },
          ],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    const body = result.items[0]!.bodyPreview;
    expect(body).not.toContain('xoxb-EXAMPLE-discordfake-zzzz');
    expect(body).toContain('[token]');
  });

  test('populates routeId from the injected route resolver', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return { body: [{ id: snowflake(1_700_000_600_000), content: 'route me', author: { id: 'A1' } }] };
      }
      return { body: [] };
    });
    const seen: Array<{ provider: string; fromDigest: string; kind: string }> = [];
    const adapter = createDiscordAdapter(
      ctxWith('bot-token', {
        resolveRouteId: async (input) => {
          seen.push(input);
          return 'route-xyz';
        },
      }),
    );
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.routeId).toBe('route-xyz');
    // The resolver receives the digested sender id, never the raw 'A1'.
    expect(seen[0]!.provider).toBe(DISCORD_PROVIDER_ID);
    expect(seen[0]!.fromDigest).toBe(digestSender('A1'));
    expect(seen[0]!.fromDigest).not.toContain('A1');
  });

  test('omits routeId when the resolver returns undefined', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        return { body: [{ id: snowflake(1_700_000_700_000), content: 'no route', author: { id: 'A1' } }] };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(
      ctxWith('bot-token', { resolveRouteId: async () => undefined }),
    );
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.routeId).toBeUndefined();
    expect('routeId' in result.items[0]!).toBe(false);
  });

  test('pages /channels/{id}/messages via the `before` cursor when a page is full', async () => {
    // limit=3 => perChannel=3. Page 1 returns 3 (full) but 2 are bots => 1 item,
    // so the adapter pages again with a `before` cursor; page 2 returns 1 (not
    // full) => stop. Both real messages must survive.
    const beforeSeen: Array<string | null> = [];
    const p1oldest = snowflake(1_700_000_000_000);
    installFetch((path, url) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        const before = url.searchParams.get('before');
        beforeSeen.push(before);
        if (!before) {
          return {
            body: [
              { id: snowflake(1_700_000_002_000), content: 'real1', author: { id: 'A1' } },
              { id: snowflake(1_700_000_001_500), content: 'bot1', author: { id: 'BOT', bot: true } },
              { id: p1oldest, content: 'bot2', author: { id: 'BOT', bot: true } },
            ],
          };
        }
        // Second page: one older real message, not a full page => pagination stops.
        return {
          body: [{ id: snowflake(1_700_000_000_500), content: 'real2', author: { id: 'A1' } }],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 3 });
    // Page 2 was requested with the `before` cursor = the oldest id of page 1.
    expect(beforeSeen[0]).toBeNull();
    expect(beforeSeen[1]).toBe(p1oldest);
    expect(result.items.map((i) => i.bodyPreview).sort()).toEqual(['real1', 'real2']);
  });

  test('since + multi-page: page 2 sends `before` WITHOUT `after`; older in-window messages survive', async () => {
    // Discord rejects after+before on the same request (mutually exclusive),
    // silently dropping older in-window messages. With `since` set and a full
    // first page, the adapter must page backwards using ONLY `before` and rely
    // on the oldestMs<=since stop condition to terminate.
    const since = 1_700_000_000_000;
    const perPageParams: Array<{ after: string | null; before: string | null }> = [];
    // Page 1: a FULL page (perChannel=10) of in-window messages, newest-first,
    // all strictly newer than since. Half are bot-authored (skipped, so the
    // item budget is NOT exhausted by page 1) while the RAW page stays full,
    // which is what forces a backward page. Oldest of page 1 is still > since
    // so the oldestMs<=since stop does not trigger after page 1.
    const page1 = Array.from({ length: 10 }, (_unused, i) => {
      const ms = since + 10_000 - i * 100; // newest..oldest, all > since
      const isBot = i % 2 === 1;
      return {
        id: snowflake(ms),
        content: `p1-${i}`,
        author: isBot ? { id: 'BOT', bot: true } : { id: 'A1' },
        timestamp: new Date(ms).toISOString(),
      };
    });
    const p1oldestId = page1[page1.length - 1]!.id;
    installFetch((path, url) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [{ id: 'C1', type: 1 }] };
      if (path.startsWith('/api/v10/channels/C1/messages')) {
        perPageParams.push({
          after: url.searchParams.get('after'),
          before: url.searchParams.get('before'),
        });
        if (!url.searchParams.get('before')) return { body: page1 };
        // Page 2: one older but still in-window message; short page => stop.
        const ms = since + 500;
        return {
          body: [{ id: snowflake(ms), content: 'p2-older', author: { id: 'A1' }, timestamp: new Date(ms).toISOString() }],
        };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10, since });
    // Two requests were made (full first page forced a backward page).
    expect(perPageParams).toHaveLength(2);
    // Page 1: `after` present (window floor), `before` absent.
    expect(perPageParams[0]!.after).toBeTruthy();
    expect(perPageParams[0]!.before).toBeNull();
    // Page 2: `before` present, `after` DROPPED (mutually exclusive).
    expect(perPageParams[1]!.before).toBe(p1oldestId);
    expect(perPageParams[1]!.after).toBeNull();
    // The older in-window message from page 2 survived (was not dropped).
    expect(result.items.some((i) => i.bodyPreview === 'p2-older')).toBe(true);
  });

  test('per-channel messages failure is skipped, other channels still mapped', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') {
        return { body: [{ id: 'C1', type: 1 }, { id: 'C2', type: 1 }] };
      }
      if (path.startsWith('/api/v10/channels/C1/messages')) return { status: 500, body: {} };
      if (path.startsWith('/api/v10/channels/C2/messages')) {
        return { body: [{ id: snowflake(1_700_000_800_000), content: 'survivor', author: { id: 'A2' } }] };
      }
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    // C1 failure did not fail the provider; C2 still produced an item.
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id.startsWith('discord:C2:')).toBe(true);
  });

  test('empty DM list => empty state', async () => {
    installFetch((path) => {
      if (path === '/api/v10/users/@me') return { body: { id: 'SELF' } };
      if (path === '/api/v10/users/@me/channels') return { body: [] };
      return { body: [] };
    });
    const adapter = createDiscordAdapter(ctxWith('bot-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('empty');
  });
});
