import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBuiltinSubscriptionProvider } from '@pellux/goodvibes-sdk/platform/config/subscription-providers';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';

describe('subscription providers', () => {
  const originalCwd = process.cwd();
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-subscription-provider-'));
    process.chdir(root);
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test('builtin openai provider matches Codex OAuth contract', () => {
    const provider = getBuiltinSubscriptionProvider('openai');
    expect(provider).not.toBeNull();
    expect(provider?.oauth.authUrl).toBe('https://auth.openai.com/oauth/authorize');
    expect(provider?.oauth.tokenUrl).toBe('https://auth.openai.com/oauth/token');
    expect(provider?.oauth.redirectUri).toBe('http://localhost:1455/auth/callback');
    expect(provider?.oauth.tokenRequestEncoding).toBe('form');
    expect(provider?.oauth.authParams?.originator).toBe('pi');
    expect(provider?.oauth.localCallback?.host).toBe('localhost');
  });

  test('subscription manager supports form token exchanges for openai codex', async () => {
    const provider = getBuiltinSubscriptionProvider('openai');
    expect(provider).not.toBeNull();

    const manager = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
    const started = manager.beginOAuthLogin('openai', provider!.oauth);
    const authUrl = new URL(started.authorizationUrl);
    expect(authUrl.searchParams.get('originator')).toBe('pi');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');

    let capturedBody = '';
    let capturedType = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedType = String((init?.headers as Record<string, string> | undefined)?.['Content-Type'] ?? '');
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        access_token: 'openai-oauth-token',
        refresh_token: 'openai-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200 });
    }) as unknown) as typeof fetch;

    try {
      const record = await manager.completeOAuthLogin('openai', provider!.oauth, 'auth-code-123');
      expect(record.provider).toBe('openai');
      expect(record.refreshToken).toBe('openai-refresh-token');
      expect(capturedType).toBe('application/x-www-form-urlencoded');
      const parsed = new URLSearchParams(capturedBody);
      expect(parsed.get('grant_type')).toBe('authorization_code');
      expect(parsed.get('client_id')).toBe(provider!.oauth.clientId);
      expect(parsed.get('code')).toBe('auth-code-123');
      expect(parsed.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(parsed.get('code_verifier')).toBe(started.pending.verifier);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('anthropic no longer has a built-in subscription provider', () => {
    expect(getBuiltinSubscriptionProvider('anthropic')).toBeNull();
  });
});
