import { describe, expect, it } from 'bun:test';
import { createTriageTagger } from '../../../daemon/handlers/triage/tagger/index.ts';
import type { ImapStoreArgs } from '../../../daemon/handlers/triage/tagger/imap.ts';
import { REQUIRE_CONFIRM } from '../../../daemon/handlers/errors.ts';
import { fakeContext, fakeCredentials, item } from './helpers.ts';

const WD = '/tmp/gv-triage-tagger-unused';

// Obvious word-style fakes — NOT real token formats.
const SLACK_TOKEN = 'xoxb-EXAMPLE-faketoken';
const DISCORD_TOKEN = 'discord-EXAMPLE-faketoken';
const IMAP_PASSWORD = 'imap-EXAMPLE-fakepass';

function confirmed<T extends object>(extra: T) {
  return { confirm: true, explicitUserRequest: true, ...extra };
}

describe('createTriageTagger gating', () => {
  it('skips when autotag is disabled', async () => {
    const ctx = fakeContext({ workingDirectory: WD });
    const tagger = createTriageTagger(ctx, { autoTagEnabled: false, providers: {} });
    const result = await tagger.applyTags(
      confirmed({ item: item({ id: 'a', surface: 'slack' }), label: 'spam' }),
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('autotag-disabled');
    expect(tagger.enabled()).toBe(false);
  });

  it('requires explicit confirmation for provider-side mutation', async () => {
    const ctx = fakeContext({ workingDirectory: WD });
    const tagger = createTriageTagger(ctx, { autoTagEnabled: true, providers: {} });
    await expect(
      tagger.applyTags({ item: item({ id: 'a', surface: 'slack' }), label: 'spam', confirm: false }),
    ).rejects.toMatchObject({ code: REQUIRE_CONFIRM, status: 403 });
    await expect(
      tagger.applyTags({ item: item({ id: 'a', surface: 'slack' }), label: 'spam', confirm: true }),
    ).rejects.toMatchObject({ code: REQUIRE_CONFIRM });
  });

  it('skips unsupported surfaces', async () => {
    const ctx = fakeContext({ workingDirectory: WD });
    const tagger = createTriageTagger(ctx, { autoTagEnabled: true, providers: {} });
    const result = await tagger.applyTags(
      confirmed({ item: item({ id: 'a', surface: 'telegram' }), label: 'normal' }),
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('unsupported-surface:telegram');
  });
});

describe('IMAP tagging', () => {
  it('stores a sanitized keyword flag via the injected store', async () => {
    const calls: ImapStoreArgs[] = [];
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.email.imap.password': IMAP_PASSWORD }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { imap: { host: 'imap.example.test', user: 'mailbot', passwordConfigKey: 'surfaces.email.imap.password' } },
      imapStoreFlag: async (args) => {
        calls.push(args);
      },
    });
    const result = await tagger.applyTags(
      confirmed({ item: item({ id: 'e1', surface: 'email', metadata: { imapUid: '42' } }), label: 'spam' }),
    );
    expect(result.skipped).toBe(false);
    expect(result.appliedTags).toEqual(['GoodVibes/Spam']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.uid).toBe('42');
    expect(calls[0]!.flag).toBe('GoodVibes_Spam'); // '/' normalized to '_'
    expect(calls[0]!.password).toBe(IMAP_PASSWORD);
  });

  it('skips when the IMAP uid is missing', async () => {
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.email.imap.password': IMAP_PASSWORD }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { imap: { host: 'imap.example.test', user: 'mailbot', passwordConfigKey: 'surfaces.email.imap.password' } },
      imapStoreFlag: async () => {},
    });
    const result = await tagger.applyTags(
      confirmed({ item: item({ id: 'e2', surface: 'email' }), label: 'spam' }),
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('imap-missing-uid');
  });

  it('skips when no IMAP credentials resolve', async () => {
    const ctx = fakeContext({ workingDirectory: WD, credentials: fakeCredentials({}) });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { imap: { host: 'imap.example.test', user: 'mailbot', passwordConfigKey: 'surfaces.email.imap.password' } },
      imapStoreFlag: async () => {},
    });
    const result = await tagger.applyTags(
      confirmed({ item: item({ id: 'e3', surface: 'email', metadata: { uid: 7 } }), label: 'normal' }),
    );
    expect(result.reason).toBe('imap-no-credentials');
  });

  it('retries transient IMAP failures and eventually succeeds', async () => {
    let attempts = 0;
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.email.imap.password': IMAP_PASSWORD }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { imap: { host: 'imap.example.test', user: 'mailbot', passwordConfigKey: 'surfaces.email.imap.password' } },
      imapStoreFlag: async () => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error('reset') as Error & { code: string };
          err.code = 'ECONNRESET';
          throw err;
        }
      },
      imapRetry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
    });
    const result = await tagger.applyTags(
      confirmed({ item: item({ id: 'e4', surface: 'imap', metadata: { uid: 9 } }), label: 'priority' }),
    );
    expect(attempts).toBe(3);
    expect(result.skipped).toBe(false);
  });
});

describe('Slack tagging', () => {
  it('adds a reaction with the bearer token and treats already_reacted as success', async () => {
    const seen: Array<{ url: string; auth: string; body: unknown }> = [];
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.slack.botToken': SLACK_TOKEN }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push({
          url,
          auth: String((init?.headers as Record<string, string>).Authorization),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ ok: false, error: 'already_reacted' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await tagger.applyTags(
      confirmed({
        item: item({ id: 's1', surface: 'slack', conversationId: 'C123', metadata: { ts: '111.222' } }),
        label: 'spam',
      }),
    );
    expect(result.skipped).toBe(false);
    expect(seen[0]!.url).toContain('reactions.add');
    expect(seen[0]!.auth).toContain(SLACK_TOKEN);
    expect((seen[0]!.body as { name: string }).name).toBe('no_entry_sign');
  });

  it('throws on a hard Slack rejection', async () => {
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.slack.botToken': SLACK_TOKEN }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { slack: { tokenConfigKey: 'surfaces.slack.botToken' } },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(
      tagger.applyTags(
        confirmed({ item: item({ id: 's2', surface: 'slack', metadata: { channelId: 'C9', ts: '1.2' } }), label: 'spam' }),
      ),
    ).rejects.toMatchObject({ code: 'TRIAGE_SLACK_TAG_FAILED' });
  });
});

describe('Discord tagging', () => {
  it('adds a unicode reaction when no forum-tag mapping is configured', async () => {
    const seen: string[] = [];
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.discord.botToken': DISCORD_TOKEN }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: { discord: { tokenConfigKey: 'surfaces.discord.botToken' } },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method} ${url}`);
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    const result = await tagger.applyTags(
      confirmed({
        item: item({ id: 'd1', surface: 'discord', metadata: { channelId: 'CH', messageId: 'MSG' } }),
        label: 'priority',
      }),
    );
    expect(result.skipped).toBe(false);
    expect(seen[0]).toContain('PUT');
    expect(seen[0]).toContain('/reactions/');
  });

  it('merges real forum thread tags (read-then-merge, never overwrite)', async () => {
    let patchedBody: { applied_tags?: string[] } | null = null;
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.discord.botToken': DISCORD_TOKEN }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: {
        discord: { tokenConfigKey: 'surfaces.discord.botToken', forumTagIds: { 'GoodVibes/Spam': 'tag-new' } },
      },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({ applied_tags: ['tag-existing'] }), { status: 200 });
        }
        patchedBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await tagger.applyTags(
      confirmed({
        item: item({ id: 'd2', surface: 'discord', metadata: { channelId: 'THREAD', threadId: 'THREAD' } }),
        label: 'spam',
      }),
    );
    expect(result.skipped).toBe(false);
    expect(patchedBody!.applied_tags).toContain('tag-existing');
    expect(patchedBody!.applied_tags).toContain('tag-new');
  });

  it('aborts a thread-tag PATCH when the existing tags cannot be read (data-loss guard)', async () => {
    let patched = false;
    const ctx = fakeContext({
      workingDirectory: WD,
      credentials: fakeCredentials({ 'surfaces.discord.botToken': DISCORD_TOKEN }),
    });
    const tagger = createTriageTagger(ctx, {
      autoTagEnabled: true,
      providers: {
        discord: { tokenConfigKey: 'surfaces.discord.botToken', forumTagIds: { 'GoodVibes/Spam': 'tag-new' } },
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        if (init?.method === 'GET') return new Response('nope', { status: 500 });
        patched = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(
      tagger.applyTags(
        confirmed({
          item: item({ id: 'd3', surface: 'discord', metadata: { channelId: 'THREAD', threadId: 'THREAD' } }),
          label: 'spam',
        }),
      ),
    ).rejects.toMatchObject({ code: 'TRIAGE_DISCORD_TAG_FAILED' });
    expect(patched).toBe(false);
  });
});
