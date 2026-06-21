import { afterEach, describe, expect, test } from 'bun:test';
import {
  createSlackAdapter,
  SLACK_PROVIDER_ID,
  SLACK_CREDENTIAL_KEY,
} from '../../../daemon/channels/inbox/providers/slack.ts';
import type { AdapterContext } from '../../../daemon/channels/inbox/provider-adapter.ts';
import { digestSender } from '../../../daemon/channels/inbox/mapping.ts';

const silentLogger = { info() {}, warn() {}, error() {} };

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
    credentials: credsFrom({ [SLACK_CREDENTIAL_KEY]: token }),
    logger: silentLogger,
    ...extra,
  };
}

// ---- fetch stub -----------------------------------------------------------
type JsonRoute = (url: URL) => unknown;
const realFetch = globalThis.fetch;

/**
 * Install a fake `fetch` that dispatches on the Slack method name (last path
 * segment). Each route returns the JSON body; `ok: true` HTTP is assumed.
 */
function installFetch(routes: Record<string, JsonRoute>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = url.pathname.split('/').pop() ?? '';
    calls.push(method);
    const route = routes[method];
    if (!route) throw new Error(`unexpected slack method: ${method}`);
    return {
      ok: true,
      status: 200,
      async json() {
        return route(url);
      },
    } as Response;
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('slack adapter', () => {
  test('missing token => unavailable with explicit error', async () => {
    const adapter = createSlackAdapter(ctxWith(null));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('missing surfaces.slack.botToken');
  });

  test('malformed token => unavailable (token shape validated before any network call)', async () => {
    const installed = installFetch({});
    const adapter = createSlackAdapter(ctxWith('not-a-slack-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('not a valid Slack');
    // No HTTP call should have been attempted.
    expect(installed.calls).toHaveLength(0);
  });

  test('maps DM messages, skips bot messages, digests sender, classifies thread', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [
          { user: 'U1', text: 'hello there', ts: '1700000000.000200' },
          { user: 'U1', text: 'reply', ts: '1700000100.000100', thread_ts: '1700000000.000200' },
          { bot_id: 'B1', text: 'i am a bot', ts: '1700000200.000100' },
          { subtype: 'bot_message', text: 'also a bot', ts: '1700000300.000100' },
        ],
      }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('ready');
    // bot messages filtered out
    expect(result.items).toHaveLength(2);
    const first = result.items[0]!;
    expect(first.id).toBe('slack:D1:1700000000.000200');
    expect(first.provider).toBe(SLACK_PROVIDER_ID);
    expect(first.fromDigest).toBe(digestSender('U1'));
    expect(first.fromDigest).not.toContain('U1');
    expect(first.kind).toBe('dm');
    expect(first.receivedAt).toBe(1_700_000_000_000);
    // thread classification
    expect(result.items[1]!.kind).toBe('thread');
  });

  test('classifies @-mention of self via auth.test user id', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [{ user: 'U1', text: 'hey <@USELF> look at this', ts: '1700000400.000100' }],
      }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('mention');
  });

  test('classifies reaction only when SOMEONE REACTED TO OUR OWN message (self-authored + reactions[])', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [
          {
            user: 'USELF', // our own message; someone (U2) reacted to it
            text: 'thanks!',
            ts: '1700000500.000100',
            reactions: [{ name: 'thumbsup', count: 1, users: ['U2'] }],
          },
        ],
      }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('reaction');
  });

  test('a normal DM authored by SOMEONE ELSE that merely carries reactions[] is a dm, not a reaction', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [
          {
            user: 'U1', // the other party’s message
            text: 'thanks!',
            ts: '1700000510.000100',
            reactions: [{ name: 'thumbsup', count: 1, users: ['U2'] }],
          },
        ],
      }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.kind).toBe('dm');
  });

  test('since filter passes oldest param and drops not-newer messages', async () => {
    let historyUrl: URL | undefined;
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': (url) => {
        historyUrl = url;
        return {
          ok: true,
          messages: [
            { user: 'U1', text: 'old', ts: '1700000000.000000' }, // == since => dropped
            { user: 'U1', text: 'new', ts: '1700000001.000000' },
          ],
        };
      },
    });
    const since = 1_700_000_000_000;
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10, since });
    expect(historyUrl?.searchParams.get('oldest')).toBe((since / 1000).toFixed(6));
    expect(result.items.map((i) => i.bodyPreview)).toEqual(['new']);
  });

  test('conversations.list ok:false => unavailable with slack error', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: false, error: 'invalid_auth' }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('invalid_auth');
  });

  test('no messages => empty state (configured but nothing to show)', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [] }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('empty');
    expect(result.items).toHaveLength(0);
  });

  test('paginates conversations.list via next_cursor (DMs past the first page are not lost)', async () => {
    const installed = installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': (url) => {
        const cursor = url.searchParams.get('cursor');
        if (!cursor) {
          return {
            ok: true,
            channels: [{ id: 'D1', user: 'U1' }],
            response_metadata: { next_cursor: 'PAGE2' },
          };
        }
        if (cursor === 'PAGE2') {
          // Second (final) page — empty next_cursor terminates pagination.
          return {
            ok: true,
            channels: [{ id: 'D2', user: 'U2' }],
            response_metadata: { next_cursor: '' },
          };
        }
        throw new Error(`unexpected cursor: ${cursor}`);
      },
      'conversations.history': (url) => {
        const ch = url.searchParams.get('channel');
        return {
          ok: true,
          messages: [{ user: 'U1', text: `${ch}-msg`, ts: '1700000000.000100' }],
        };
      },
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    // conversations.list called twice (page 1 + page 2 via cursor).
    expect(installed.calls.filter((c) => c === 'conversations.list')).toHaveLength(2);
    // A message from the SECOND page's DM channel is present.
    expect(result.items.some((i) => i.id.startsWith('slack:D2:'))).toBe(true);
    expect(result.items.some((i) => i.id.startsWith('slack:D1:'))).toBe(true);
  });

  test('redacts a leaked token in message text end-to-end through toBodyPreview', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [
          {
            user: 'U1',
            text: 'here is my key xoxb-EXAMPLE-slackfake-zzzz and bearer Bearer abcDEF123456ghiJKL789',
            ts: '1700000600.000100',
          },
        ],
      }),
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    const body = result.items[0]!.bodyPreview;
    // The actual secret material must never survive into the preview.
    expect(body).not.toContain('xoxb-EXAMPLE-slackfake-zzzz');
    expect(body).not.toContain('abcDEF123456ghiJKL789');
    expect(body).toContain('[token]');
  });

  test('populates routeId from the injected route resolver', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [{ user: 'U1', text: 'route me', ts: '1700000700.000100' }],
      }),
    });
    const seen: Array<{ provider: string; fromDigest: string; kind: string }> = [];
    const adapter = createSlackAdapter(
      ctxWith('xoxb-valid-token', {
        resolveRouteId: async (input) => {
          seen.push(input);
          return 'route-123';
        },
      }),
    );
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.routeId).toBe('route-123');
    // The resolver receives the digested sender id, never the raw 'U1'.
    expect(seen[0]!.provider).toBe(SLACK_PROVIDER_ID);
    expect(seen[0]!.fromDigest).toBe(digestSender('U1'));
    expect(seen[0]!.fromDigest).not.toContain('U1');
  });

  test('omits routeId when the resolver returns undefined', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': () => ({
        ok: true,
        messages: [{ user: 'U1', text: 'no route', ts: '1700000800.000100' }],
      }),
    });
    const adapter = createSlackAdapter(
      ctxWith('xoxb-valid-token', { resolveRouteId: async () => undefined }),
    );
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.routeId).toBeUndefined();
    expect('routeId' in result.items[0]!).toBe(false);
  });

  test('paginates conversations.history via has_more + next_cursor (busy DM not truncated)', async () => {
    const installed = installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({ ok: true, channels: [{ id: 'D1', user: 'U1' }] }),
      'conversations.history': (url) => {
        const cursor = url.searchParams.get('cursor');
        if (!cursor) {
          return {
            ok: true,
            messages: [{ user: 'U1', text: 'page1', ts: '1700000002.000000' }],
            has_more: true,
            response_metadata: { next_cursor: 'H2' },
          };
        }
        if (cursor === 'H2') {
          return {
            ok: true,
            messages: [{ user: 'U1', text: 'page2', ts: '1700000001.000000' }],
            has_more: false,
            response_metadata: { next_cursor: '' },
          };
        }
        throw new Error(`unexpected history cursor: ${cursor}`);
      },
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    // history called twice: first page + cursor-driven second page.
    expect(installed.calls.filter((c) => c === 'conversations.history')).toHaveLength(2);
    expect(result.items.map((i) => i.bodyPreview).sort()).toEqual(['page1', 'page2']);
  });

  test('per-channel conversations.history ok:false is skipped, other channels still mapped', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({
        ok: true,
        channels: [{ id: 'D1', user: 'U1' }, { id: 'D2', user: 'U2' }],
      }),
      'conversations.history': (url) => {
        const ch = url.searchParams.get('channel');
        if (ch === 'D1') return { ok: false, error: 'channel_not_found' };
        return { ok: true, messages: [{ user: 'U2', text: 'survivor', ts: '1700000900.000100' }] };
      },
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 10 });
    // D1 failure did not fail the provider; D2 still produced an item.
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id.startsWith('slack:D2:')).toBe(true);
  });

  test('respects the limit across multiple DM channels', async () => {
    installFetch({
      'auth.test': () => ({ ok: true, user_id: 'USELF' }),
      'conversations.list': () => ({
        ok: true,
        channels: [{ id: 'D1', user: 'U1' }, { id: 'D2', user: 'U2' }],
      }),
      'conversations.history': (url) => {
        const ch = url.searchParams.get('channel');
        return {
          ok: true,
          messages: [
            { user: 'U1', text: `${ch}-a`, ts: '1700000000.000100' },
            { user: 'U1', text: `${ch}-b`, ts: '1700000000.000200' },
          ],
        };
      },
    });
    const adapter = createSlackAdapter(ctxWith('xoxb-valid-token'));
    const result = await adapter.poll({ limit: 3 });
    expect(result.items).toHaveLength(3);
  });
});
