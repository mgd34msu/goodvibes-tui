import { describe, expect, test } from 'bun:test';
import { createTriageTagger, type ImapStoreArgs } from '../../../daemon/triage/tagger.ts';
import {
  OperatorError,
  REQUIRE_CONFIRM,
  type DaemonCredentialStore,
  type InboundChannelItem,
  type OperatorContext,
} from '../../../daemon/operator/index.ts';

function makeCtx(): OperatorContext {
  return {
    catalog: {} as OperatorContext['catalog'],
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory: '/tmp/triage-test',
    homeDirectory: '/tmp/triage-test',
    logger: { info() {}, warn() {}, error() {} },
  };
}

function fakeCreds(tokens: Record<string, string>): DaemonCredentialStore {
  return {
    async resolveRef(ref) {
      return tokens[ref] ?? null;
    },
    async resolveConfigSecret(configKey) {
      return tokens[configKey] ?? null;
    },
    async put() {},
    async has(key) {
      return tokens[key] !== undefined;
    },
  };
}

function item(partial: Partial<InboundChannelItem>): InboundChannelItem {
  return {
    id: partial.id ?? 'i-1',
    surface: partial.surface ?? 'slack',
    fromDigest: 'abc',
    messageDigest: 'def',
    receivedAt: '2026-06-20T00:00:00.000Z',
    unread: true,
    ...partial,
  };
}

const CONFIRMED = { confirm: true as const, explicitUserRequest: true };

describe('createTriageTagger gating', () => {
  test('no-ops with skipped:true when autotag flag is disabled', async () => {
    const tagger = createTriageTagger(makeCtx(), { autoTagEnabled: false, credentials: fakeCreds({}) });
    expect(tagger.enabled()).toBe(false);
    const result = await tagger.applyTags({ item: item({}), label: 'spam', ...CONFIRMED });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('autotag-disabled');
    expect(result.appliedTags).toEqual([]);
  });

  test('throws REQUIRE_CONFIRM when enabled but not confirmed', async () => {
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.slack.botToken': 'xoxb-1' }),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
    });
    await expect(
      tagger.applyTags({
        item: item({ conversationId: 'C1', metadata: { ts: '1.2' } }),
        label: 'spam',
        confirm: false,
        explicitUserRequest: true,
      }),
    ).rejects.toMatchObject({ code: REQUIRE_CONFIRM });
  });

  test('throws REQUIRE_CONFIRM when confirmed but not an explicit user request', async () => {
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.slack.botToken': 'xoxb-1' }),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
    });
    await expect(
      tagger.applyTags({
        item: item({ conversationId: 'C1', metadata: { ts: '1.2' } }),
        label: 'spam',
        confirm: true,
        explicitUserRequest: false,
      }),
    ).rejects.toBeInstanceOf(OperatorError);
  });
});

describe('Slack tagging', () => {
  test('posts reactions.add with the bearer token and never returns it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.slack.botToken': 'xoxb-secret' }),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl,
    });

    const result = await tagger.applyTags({
      item: item({ surface: 'slack', conversationId: 'C123', metadata: { ts: '1700000000.000100' } }),
      label: 'priority',
      ...CONFIRMED,
    });

    expect(result.skipped).toBe(false);
    expect(result.appliedTags).toEqual(['GoodVibes/Priority']);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/reactions.add');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xoxb-secret');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ channel: 'C123', timestamp: '1700000000.000100', name: 'rotating_light' });
    // The token must not leak into the operator-facing result.
    expect(JSON.stringify(result)).not.toContain('xoxb-secret');
  });

  test('treats already_reacted as idempotent success', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'already_reacted' }), { status: 200 })) as unknown as typeof fetch;
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.slack.botToken': 'xoxb' }),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl,
    });
    const result = await tagger.applyTags({
      item: item({ surface: 'slack', conversationId: 'C1', metadata: { ts: '1.1' } }),
      label: 'spam',
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(false);
    expect(result.appliedTags).toEqual(['GoodVibes/Spam']);
  });

  test('throws on a genuine Slack error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 })) as unknown as typeof fetch;
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.slack.botToken': 'xoxb' }),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl,
    });
    await expect(
      tagger.applyTags({
        item: item({ surface: 'slack', conversationId: 'C1', metadata: { ts: '1.1' } }),
        label: 'spam',
        ...CONFIRMED,
      }),
    ).rejects.toMatchObject({ code: 'TRIAGE_SLACK_TAG_FAILED' });
  });

  test('skips when credentials are absent', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({}),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl,
    });
    const result = await tagger.applyTags({
      item: item({ surface: 'slack', conversationId: 'C1', metadata: { ts: '1.1' } }),
      label: 'spam',
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('slack-no-credentials');
  });

  test('skips with no-tags (no fetch, no credential read) when tags resolve empty', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.slack.botToken': 'xoxb-secret' }),
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl,
    });
    const result = await tagger.applyTags({
      item: item({ surface: 'slack', conversationId: 'C1', metadata: { ts: '1.1' } }),
      tags: [],
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-tags');
    expect(result.appliedTags).toEqual([]);
    expect(fetched).toBe(false);
  });
});

describe('Discord tagging', () => {
  test('skips with no-tags (no fetch, no credential read) when tags resolve empty', async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: {
        discord: {
          tokenConfigKey: 'surfaces.discord.botToken',
          forumTagIds: { 'GoodVibes/Spam': 'spam-tag-id' },
        },
      },
      fetchImpl,
    });
    const result = await tagger.applyTags({
      item: item({ surface: 'discord', id: 'M1', metadata: { channelId: 'CH1', messageId: 'M1' } }),
      tags: [],
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-tags');
    expect(result.appliedTags).toEqual([]);
    expect(fetched).toBe(false);
  });

  test('PUTs a reaction with a Bot token and accepts 204', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: { discord: { tokenConfigKey: 'surfaces.discord.botToken' } },
      fetchImpl,
    });

    const result = await tagger.applyTags({
      item: item({ surface: 'discord', id: 'M1', metadata: { channelId: 'CH1', messageId: 'M1' } }),
      label: 'spam',
      ...CONFIRMED,
    });

    expect(result.skipped).toBe(false);
    expect(result.appliedTags).toEqual(['GoodVibes/Spam']);
    expect(calls[0]!.url).toContain('/channels/CH1/messages/M1/reactions/');
    expect(calls[0]!.url).toContain('/@me');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bot bot-secret');
    expect(calls[0]!.init.method).toBe('PUT');
  });

  test('throws on a Discord HTTP error', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot' }),
      providers: { discord: { tokenConfigKey: 'surfaces.discord.botToken' } },
      fetchImpl,
    });
    await expect(
      tagger.applyTags({
        item: item({ surface: 'discord', id: 'M1', metadata: { channelId: 'CH1', messageId: 'M1' } }),
        label: 'spam',
        ...CONFIRMED,
      }),
    ).rejects.toMatchObject({ code: 'TRIAGE_DISCORD_TAG_FAILED' });
  });

  test('applies REAL thread tags (PATCH applied_tags) when forumTagIds is configured', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      // GET thread -> one pre-existing tag; PATCH -> 200 OK.
      if (!init || init.method === 'GET') {
        return new Response(JSON.stringify({ applied_tags: ['existing-tag'] }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: {
        discord: {
          tokenConfigKey: 'surfaces.discord.botToken',
          forumTagIds: { 'GoodVibes/Spam': 'spam-tag-id' },
        },
      },
      fetchImpl,
    });

    const result = await tagger.applyTags({
      // A forum post: the message id IS the thread id (channelId == threadId).
      item: item({ surface: 'discord', id: 'T1', metadata: { channelId: 'T1', messageId: 'T1' } }),
      label: 'spam',
      ...CONFIRMED,
    });

    expect(result.skipped).toBe(false);
    expect(result.appliedTags).toEqual(['GoodVibes/Spam']);

    const patch = calls.find((c) => c.init.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch!.url).toBe('https://discord.com/api/v10/channels/T1');
    // Merges the new forum-tag id with the thread's existing tags (idempotent).
    expect(JSON.parse(String(patch!.init.body))).toEqual({
      applied_tags: ['existing-tag', 'spam-tag-id'],
    });
    // No reaction PUT on the reaction endpoint when the thread-tag path runs.
    expect(calls.some((c) => c.url.includes('/reactions/'))).toBe(false);
    const headers = patch!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bot bot-secret');
  });

  test('ABORTS the PATCH (no overwrite) when the existing-tags GET fails', async () => {
    // DATA-LOSS regression guard: if the GET that reads the thread's current
    // applied_tags fails, we do NOT know the existing tag set, so the tagger
    // must NOT issue a PATCH (which would replace applied_tags with only our
    // new id, destroying any pre-existing forum tags). It must surface an error.
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method });
      // GET the thread -> server error (non-ok). PATCH (should never run) -> 200.
      if (method === 'GET') return new Response('upstream down', { status: 500 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: {
        discord: {
          tokenConfigKey: 'surfaces.discord.botToken',
          forumTagIds: { 'GoodVibes/Spam': 'spam-tag-id' },
        },
      },
      fetchImpl,
    });

    await expect(
      tagger.applyTags({
        item: item({ surface: 'discord', id: 'T1', metadata: { channelId: 'T1', messageId: 'T1' } }),
        label: 'spam',
        ...CONFIRMED,
      }),
    ).rejects.toMatchObject({ code: 'TRIAGE_DISCORD_TAG_FAILED' });

    // The GET was attempted; the destructive PATCH was NOT.
    expect(calls.some((c) => c.method === 'GET')).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('ABORTS the PATCH (no overwrite) when the existing-tags GET throws', async () => {
    const calls: Array<{ method: string }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method });
      if (method === 'GET') throw new Error('network down');
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: {
        discord: {
          tokenConfigKey: 'surfaces.discord.botToken',
          forumTagIds: { 'GoodVibes/Spam': 'spam-tag-id' },
        },
      },
      fetchImpl,
    });

    await expect(
      tagger.applyTags({
        item: item({ surface: 'discord', id: 'T1', metadata: { channelId: 'T1', messageId: 'T1' } }),
        label: 'spam',
        ...CONFIRMED,
      }),
    ).rejects.toMatchObject({ code: 'TRIAGE_DISCORD_TAG_FAILED' });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('still merges correctly when the thread genuinely has NO existing tags', async () => {
    // A successful read returning an empty applied_tags must NOT be treated as a
    // failure: the PATCH proceeds with just the new id.
    const calls: Array<{ method: string; body?: unknown }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') return new Response(JSON.stringify({ applied_tags: [] }), { status: 200 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: {
        discord: {
          tokenConfigKey: 'surfaces.discord.botToken',
          forumTagIds: { 'GoodVibes/Spam': 'spam-tag-id' },
        },
      },
      fetchImpl,
    });

    const result = await tagger.applyTags({
      item: item({ surface: 'discord', id: 'T1', metadata: { channelId: 'T1', messageId: 'T1' } }),
      label: 'spam',
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(false);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ applied_tags: ['spam-tag-id'] });
  });

  test('falls back to a reaction when no forumTagIds entry maps the tag', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.discord.botToken': 'bot-secret' }),
      providers: {
        discord: {
          tokenConfigKey: 'surfaces.discord.botToken',
          // Mapping exists but does not cover GoodVibes/Spam -> reaction analog.
          forumTagIds: { 'GoodVibes/Priority': 'prio-tag-id' },
        },
      },
      fetchImpl,
    });

    const result = await tagger.applyTags({
      item: item({ surface: 'discord', id: 'M1', metadata: { channelId: 'CH1', messageId: 'M1' } }),
      label: 'spam',
      ...CONFIRMED,
    });

    expect(result.appliedTags).toEqual(['GoodVibes/Spam']);
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/reactions/');
  });
});

describe('IMAP tagging', () => {
  test('stores a normalized keyword flag via the injected store fn', async () => {
    const stored: ImapStoreArgs[] = [];
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.email.imap.password': 'imap-pw' }),
      providers: {
        imap: { host: 'imap.example.com', port: 993, user: 'me@example.com', passwordConfigKey: 'surfaces.email.imap.password', mailbox: 'INBOX' },
      },
      imapStoreFlag: async (args) => {
        stored.push(args);
      },
    });

    const result = await tagger.applyTags({
      item: item({ surface: 'email', id: 'e1', metadata: { imapUid: 42 } }),
      label: 'spam',
      ...CONFIRMED,
    });

    expect(result.skipped).toBe(false);
    expect(stored.length).toBe(1);
    expect(stored[0]!.uid).toBe('42');
    expect(stored[0]!.flag).toBe('GoodVibes_Spam'); // '/' normalized to '_'
    expect(stored[0]!.password).toBe('imap-pw');
    expect(JSON.stringify(result)).not.toContain('imap-pw');
  });

  test('rejects CRLF injection in IMAP user/password/mailbox (no socket)', async () => {
    // SECURITY regression guard: CR/LF in any value interpolated into an IMAP
    // command line is a command-injection vector. The default TLS store impl
    // (no imapStoreFlag injected, so the real quoting path runs) must reject
    // such values BEFORE issuing LOGIN/SELECT — deterministically, with no
    // retry. We assert each field independently.
    const injectionFields = [
      { user: 'me@example.com\r\nA1 LOGOUT', password: 'pw', mailbox: 'INBOX' },
      { user: 'me@example.com', password: 'pw\r\nA1 DELETE INBOX', mailbox: 'INBOX' },
      { user: 'me@example.com', password: 'pw', mailbox: 'INBOX\r\nA1 DELETE INBOX' },
      // A bare LF (not just full CRLF) is equally dangerous.
      { user: 'me@example.com', password: 'pw', mailbox: 'INBOX\nA1 NOOP' },
    ];

    for (const fields of injectionFields) {
      const tagger = createTriageTagger(makeCtx(), {
        autoTagEnabled: true,
        credentials: fakeCreds({ 'surfaces.email.imap.password': fields.password }),
        providers: {
          imap: {
            host: 'imap.example.com',
            port: 993,
            user: fields.user,
            passwordConfigKey: 'surfaces.email.imap.password',
            mailbox: fields.mailbox,
          },
        },
        // No imapStoreFlag injected -> the real imapStoreFlagOverTls runs and its
        // pre-connect validation must reject before any socket work.
        imapRetry: { maxAttempts: 1 },
      });

      await expect(
        tagger.applyTags({
          item: item({ surface: 'email', id: 'e1', metadata: { imapUid: 42 } }),
          label: 'spam',
          ...CONFIRMED,
        }),
      ).rejects.toThrow(/control characters|CRLF/i);
    }
  });

  test('skips when the IMAP uid is missing', async () => {
    const tagger = createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.email.imap.password': 'pw' }),
      providers: {
        imap: { host: 'h', user: 'u', passwordConfigKey: 'surfaces.email.imap.password' },
      },
      imapStoreFlag: async () => {},
    });
    const result = await tagger.applyTags({
      item: item({ surface: 'email', id: 'e2', metadata: {} }),
      label: 'spam',
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('imap-missing-uid');
  });
});

function transientError(code: string): Error {
  const err = new Error(`socket ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('IMAP transient-failure retry', () => {
  function imapTagger(
    imapStoreFlag: (args: ImapStoreArgs) => Promise<void>,
    imapRetry?: { maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> },
  ) {
    return createTriageTagger(makeCtx(), {
      autoTagEnabled: true,
      credentials: fakeCreds({ 'surfaces.email.imap.password': 'imap-pw' }),
      providers: {
        imap: { host: 'h', port: 993, user: 'u', passwordConfigKey: 'surfaces.email.imap.password', mailbox: 'INBOX' },
      },
      imapStoreFlag,
      ...(imapRetry ? { imapRetry } : {}),
    });
  }

  const imapItem = () => item({ surface: 'email', id: 'e1', metadata: { imapUid: 42 } });

  test('retries a transient failure and then succeeds', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const tagger = imapTagger(
      async () => {
        attempts += 1;
        if (attempts < 3) throw transientError('ECONNRESET');
      },
      { maxAttempts: 3, baseDelayMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );

    const result = await tagger.applyTags({ item: imapItem(), label: 'spam', ...CONFIRMED });
    expect(result.skipped).toBe(false);
    expect(attempts).toBe(3);
    // Exponential backoff: 10ms then 20ms before the 3rd (successful) attempt.
    expect(sleeps).toEqual([10, 20]);
  });

  test('gives up after maxAttempts on a persistent transient failure', async () => {
    let attempts = 0;
    const tagger = imapTagger(
      async () => {
        attempts += 1;
        throw transientError('ETIMEDOUT');
      },
      { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
    );

    await expect(
      tagger.applyTags({ item: imapItem(), label: 'spam', ...CONFIRMED }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(attempts).toBe(2);
  });

  test('does NOT retry a non-transient (protocol) failure', async () => {
    let attempts = 0;
    const tagger = imapTagger(
      async () => {
        attempts += 1;
        throw new Error('IMAP command failed: NO permission denied');
      },
      { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} },
    );

    await expect(
      tagger.applyTags({ item: imapItem(), label: 'spam', ...CONFIRMED }),
    ).rejects.toThrow(/permission denied/);
    expect(attempts).toBe(1);
  });
});

describe('unsupported surfaces', () => {
  test('reports an unsupported-surface reason', async () => {
    const tagger = createTriageTagger(makeCtx(), { autoTagEnabled: true, credentials: fakeCreds({}) });
    const result = await tagger.applyTags({
      item: item({ surface: 'sms' }),
      label: 'normal',
      ...CONFIRMED,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('unsupported-surface:sms');
  });
});
