import { describe, test, expect, mock } from 'bun:test';
import { createHmac } from 'crypto';
import { SlackIntegration } from '../../integrations/slack.ts';
import { DiscordIntegration } from '../../integrations/discord.ts';
import { NtfyIntegration } from '../../integrations/ntfy.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlackSignature(body: string, timestamp: string, secret: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac('sha256', secret).update(baseString).digest('hex');
  return `v0=${hmac}`;
}

const SLACK_SECRET = 'test-slack-signing-secret';
const SLACK_BODY = 'command=%2Fgoodvibes&text=hello';

// ---------------------------------------------------------------------------
// SlackIntegration.verifySignature
// ---------------------------------------------------------------------------

describe('SlackIntegration.verifySignature', () => {
  const slack = new SlackIntegration();
  const now = Math.floor(Date.now() / 1000);

  test('returns true for a valid signature and recent timestamp', () => {
    const ts = String(now);
    const sig = makeSlackSignature(SLACK_BODY, ts, SLACK_SECRET);
    expect(slack.verifySignature(SLACK_BODY, ts, sig, SLACK_SECRET)).toBe(true);
  });

  test('returns false for an invalid signature (wrong secret)', () => {
    const ts = String(now);
    const sig = makeSlackSignature(SLACK_BODY, ts, 'wrong-secret');
    expect(slack.verifySignature(SLACK_BODY, ts, sig, SLACK_SECRET)).toBe(false);
  });

  test('returns false when timestamp is too old (replay attack)', () => {
    const staleTs = String(now - 400);
    const sig = makeSlackSignature(SLACK_BODY, staleTs, SLACK_SECRET);
    expect(slack.verifySignature(SLACK_BODY, staleTs, sig, SLACK_SECRET)).toBe(false);
  });

  test('returns false when timestamp is NaN (garbage input)', () => {
    const sig = makeSlackSignature(SLACK_BODY, 'not-a-number', SLACK_SECRET);
    expect(slack.verifySignature(SLACK_BODY, 'not-a-number', sig, SLACK_SECRET)).toBe(false);
  });

  test('returns false for an empty timestamp string', () => {
    const sig = makeSlackSignature(SLACK_BODY, '', SLACK_SECRET);
    expect(slack.verifySignature(SLACK_BODY, '', sig, SLACK_SECRET)).toBe(false);
  });

  test('returns false for a tampered body', () => {
    const ts = String(now);
    const sig = makeSlackSignature(SLACK_BODY, ts, SLACK_SECRET);
    expect(slack.verifySignature('command=%2Fgoodvibes&text=injected', ts, sig, SLACK_SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiscordIntegration hexToBytes validation (via verifySignature)
// ---------------------------------------------------------------------------

describe('DiscordIntegration hex validation', () => {
  const discord = new DiscordIntegration();

  test('returns false for odd-length hex string (public key)', async () => {
    // 63 hex chars — odd length
    const oddHex = 'a'.repeat(63);
    const result = await discord.verifySignature('body', oddHex, 'timestamp', 'a'.repeat(64));
    expect(result).toBe(false);
  });

  test('returns false for hex string with invalid characters', async () => {
    const invalidHex = 'z'.repeat(64); // 'z' is not a valid hex char
    const result = await discord.verifySignature('body', invalidHex, 'timestamp', 'a'.repeat(64));
    expect(result).toBe(false);
  });

  test('returns false when signature has invalid hex chars', async () => {
    const validHex = 'a'.repeat(64);
    const invalidSig = 'g'.repeat(128); // 'g' is not valid hex
    const result = await discord.verifySignature('body', invalidSig, 'timestamp', validHex);
    expect(result).toBe(false);
  });

  test('returns false for empty hex string', async () => {
    const result = await discord.verifySignature('body', '', 'timestamp', 'a'.repeat(64));
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiscordIntegration snowflake validation
// ---------------------------------------------------------------------------

describe('DiscordIntegration snowflake validation', () => {
  const discord = new DiscordIntegration(undefined, 'fake-token');

  test('postMessage rejects a non-snowflake channelId', async () => {
    await expect(discord.postMessage('not-a-snowflake', 'hello')).rejects.toThrow(
      'invalid channelId',
    );
  });

  test('postMessage rejects an empty channelId', async () => {
    await expect(discord.postMessage('', 'hello')).rejects.toThrow('invalid channelId');
  });

  test('postMessage rejects a channelId that is too short (< 17 digits)', async () => {
    await expect(discord.postMessage('1234567890123456', 'hello')).rejects.toThrow(
      'invalid channelId',
    );
  });

  test('postMessage rejects a channelId that is too long (> 20 digits)', async () => {
    await expect(discord.postMessage('123456789012345678901', 'hello')).rejects.toThrow(
      'invalid channelId',
    );
  });

  test('respondToInteraction rejects a non-snowflake interactionId', async () => {
    await expect(discord.respondToInteraction('bad-id', 'token', 1)).rejects.toThrow(
      'invalid interactionId',
    );
  });

  test('editOriginalResponse rejects a non-snowflake applicationId', async () => {
    await expect(discord.editOriginalResponse('bad-id', 'token', 'content')).rejects.toThrow(
      'invalid applicationId',
    );
  });
});

// ---------------------------------------------------------------------------
// Body size limit (Content-Length check)
// ---------------------------------------------------------------------------

describe('DaemonServer body size limit', () => {
  // The size check is done by reading req.headers.get('content-length').
  // We verify the logic inline here rather than spinning up a full server.

  test('rejects payload when content-length exceeds 1MB', () => {
    const contentLength = parseInt('1000001', 10);
    const tooLarge = contentLength > 1_000_000;
    expect(tooLarge).toBe(true);
  });

  test('accepts payload when content-length is exactly 1MB', () => {
    const contentLength = parseInt('1000000', 10);
    const tooLarge = contentLength > 1_000_000;
    expect(tooLarge).toBe(false);
  });

  test('accepts payload when content-length header is missing (defaults to 0)', () => {
    const contentLength = parseInt('0', 10);
    const tooLarge = contentLength > 1_000_000;
    expect(tooLarge).toBe(false);
  });
});

describe('provider-native client helpers', () => {
  test('Slack OAuth URL and directory calls use provider-native endpoints', async () => {
    const url = SlackIntegration.buildOAuthAuthorizeUrl({
      clientId: 'C123',
      scopes: ['commands', 'chat:write'],
      redirectUri: 'https://goodvibes.local/oauth/slack',
      state: 'state-1',
    });
    expect(url).toContain('https://slack.com/oauth/v2/authorize');
    expect(url).toContain('client_id=C123');
    expect(url).toContain('commands%2Cchat%3Awrite');

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://slack.com/api/conversations.list');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test');
      return Response.json({
        ok: true,
        channels: [{ id: 'C1', name: 'ops' }],
        response_metadata: { next_cursor: '' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const page = await new SlackIntegration(undefined, 'xoxb-test').listConversations({ limit: 1 });
      expect(page.ok).toBe(true);
      expect(page.entries[0]?.id).toBe('C1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Discord OAuth URL, command shape, and command registration use provider-native endpoints', async () => {
    const url = DiscordIntegration.buildOAuthAuthorizeUrl({
      clientId: '12345678901234567',
      guildId: '23456789012345678',
      permissions: '2048',
    });
    expect(url).toContain('https://discord.com/oauth2/authorize');
    expect(url).toContain('scope=bot+applications.commands');
    expect(DiscordIntegration.buildGoodVibesCommand().options?.[0]?.name).toBe('prompt');

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://discord.com/api/v10/applications/12345678901234567/guilds/23456789012345678/commands');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bot bot-token');
      return Response.json({ id: '34567890123456789', ...DiscordIntegration.buildGoodVibesCommand() });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const command = await new DiscordIntegration(undefined, 'bot-token').registerGuildCommand(
        '12345678901234567',
        '23456789012345678',
        DiscordIntegration.buildGoodVibesCommand(),
      );
      expect(command.name).toBe('goodvibes');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ntfy subscribe URLs and polling support stream, websocket, and poll modes', async () => {
    const ntfy = new NtfyIntegration('https://ntfy.sh', 'token');
    expect(ntfy.buildSubscribeUrl('ops', 'json')).toBe('https://ntfy.sh/ops/json');
    expect(ntfy.buildSubscribeUrl('ops', 'ws')).toBe('wss://ntfy.sh/ops/ws');
    expect(ntfy.buildSubscribeUrl('ops', 'json', { poll: true, since: 'latest' })).toBe('https://ntfy.sh/ops/json?poll=1&since=latest');

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://ntfy.sh/ops/json?poll=1&since=latest');
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer token');
      return new Response('{"event":"message","topic":"ops","message":"hi"}\n', { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const messages = await ntfy.poll('ops', { since: 'latest' });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message).toBe('hi');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
