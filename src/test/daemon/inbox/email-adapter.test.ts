import { describe, expect, test } from 'bun:test';
import { createEmailAdapter } from '../../../daemon/channels/inbox/providers/email.ts';
import type { ImapLike } from '../../../daemon/channels/inbox/providers/email.ts';
import type { AdapterContext } from '../../../daemon/channels/inbox/provider-adapter.ts';
import type { ImapEnvelope } from '../../../daemon/channels/inbox/providers/imap-client.ts';
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

function fakeImap(envelopes: ImapEnvelope[]): ImapLike {
  return {
    async connect() {},
    async login() {},
    async select() {},
    async searchUids() {
      return envelopes.map((e) => e.uid);
    },
    async fetchEnvelopes(uids) {
      const set = new Set(uids);
      return envelopes.filter((e) => set.has(e.uid));
    },
    async logout() {},
    close() {},
  };
}

describe('email adapter', () => {
  test('returns unavailable with an explicit error when credentials are missing', async () => {
    const ctx: AdapterContext = { credentials: credsFrom({}), logger: silentLogger };
    const adapter = createEmailAdapter(ctx, () => fakeImap([]));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('unavailable');
    expect(result.error).toContain('missing email IMAP credentials');
  });

  test('maps IMAP envelopes to wire items with digested sender and PII-safe previews', async () => {
    const ctx: AdapterContext = {
      credentials: credsFrom({
        'surfaces.email.imapHost': 'imap.example.com',
        'surfaces.email.imapUser': 'me@example.com',
        'surfaces.email.imapPassword': 'app-pass',
      }),
      logger: silentLogger,
    };
    const envelopes: ImapEnvelope[] = [
      {
        uid: 11,
        from: 'Alice <alice@example.com>',
        subject: 'Lunch?',
        date: 1_700_000_000_000,
        seen: false,
        bodyPreview: 'Reach me at bob@secret.com or 555-123-4567 please',
      },
    ];
    const adapter = createEmailAdapter(ctx, () => fakeImap(envelopes));
    const result = await adapter.poll({ limit: 10 });
    expect(result.state).toBe('ready');
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.id).toBe('email:me@example.com:11');
    expect(item.provider).toBe('email');
    expect(item.unread).toBe(true);
    expect(item.fromDigest).toBe(digestSender('email:alice@example.com'));
    // PII stripped from preview
    expect(item.bodyPreview).not.toContain('bob@secret.com');
    expect(item.bodyPreview).toContain('[email]');
    expect(item.bodyPreview).toContain('[phone]');
  });

  test('since filter drops older messages', async () => {
    const ctx: AdapterContext = {
      credentials: credsFrom({
        'surfaces.email.imapHost': 'imap.example.com',
        'surfaces.email.imapUser': 'me@example.com',
        'surfaces.email.imapPassword': 'app-pass',
      }),
      logger: silentLogger,
    };
    const envelopes: ImapEnvelope[] = [
      { uid: 1, from: 'a@x.com', subject: 'old', date: 1000, seen: true, bodyPreview: 'old' },
      { uid: 2, from: 'b@x.com', subject: 'new', date: 5000, seen: false, bodyPreview: 'new' },
    ];
    const adapter = createEmailAdapter(ctx, () => fakeImap(envelopes));
    const result = await adapter.poll({ limit: 10, since: 2000 });
    expect(result.items.map((i) => i.id)).toEqual(['email:me@example.com:2']);
  });

  test('route resolver, when present, annotates items with routeId', async () => {
    const ctx: AdapterContext = {
      credentials: credsFrom({
        'surfaces.email.imapHost': 'imap.example.com',
        'surfaces.email.imapUser': 'me@example.com',
        'surfaces.email.imapPassword': 'app-pass',
      }),
      logger: silentLogger,
      resolveRouteId: async () => 'route-42',
    };
    const envelopes: ImapEnvelope[] = [
      { uid: 9, from: 'c@x.com', subject: 's', date: 9000, seen: false, bodyPreview: 'b' },
    ];
    const adapter = createEmailAdapter(ctx, () => fakeImap(envelopes));
    const result = await adapter.poll({ limit: 10 });
    expect(result.items[0]!.routeId).toBe('route-42');
  });
});
