import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionPanel } from '../../panels/subscription-panel.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('SubscriptionPanel', () => {
  const originalCwd = process.cwd();
  let root: string;
  let serviceRegistry: ServiceRegistry;
  let subscriptionManager: SubscriptionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-subscription-panel-'));
    process.chdir(root);
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    subscriptionManager = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
    serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager,
    });
  });

  afterEach(() => {
    mock.restore();
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  test('renders configured providers and active overrides', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      access_token: 'oauth-openai-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const manager = subscriptionManager;
      await manager.beginOAuthLogin('openai', {
        authUrl: 'https://auth.openai.com/oauth/authorize',
        tokenUrl: 'https://auth.openai.com/oauth/token',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        redirectUri: 'http://localhost:1455/auth/callback',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      });
      await manager.completeOAuthLogin('openai', {
        authUrl: 'https://auth.openai.com/oauth/authorize',
        tokenUrl: 'https://auth.openai.com/oauth/token',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        redirectUri: 'http://localhost:1455/auth/callback',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      }, 'oauth-code');

      const panel = new SubscriptionPanel(serviceRegistry, subscriptionManager);
      panel.onActivate();
      panel.handleInput('ArrowDown');
      const text = linesText(panel.render(110, 14));
      expect(text).toContain('Provider Subscriptions');
      expect(text).toContain('Subscription posture');
      expect(text).toContain('openai');
      expect(text).toContain('ACTIVE');
      expect(text).toContain('override=active');
      expect(text).toContain('overrides ambient API-key resolution');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requires confirmation before signing out the selected provider', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      access_token: 'oauth-openai-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const manager = subscriptionManager;
      await manager.beginOAuthLogin('openai', {
        authUrl: 'https://auth.openai.com/oauth/authorize',
        tokenUrl: 'https://auth.openai.com/oauth/token',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        redirectUri: 'http://localhost:1455/auth/callback',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      });
      await manager.completeOAuthLogin('openai', {
        authUrl: 'https://auth.openai.com/oauth/authorize',
        tokenUrl: 'https://auth.openai.com/oauth/token',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        redirectUri: 'http://localhost:1455/auth/callback',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      }, 'oauth-code');

      const panel = new SubscriptionPanel(serviceRegistry, subscriptionManager);
      panel.onActivate();
      expect(panel.handleInput('enter')).toBe(true);
      let text = linesText(panel.render(110, 16));
      expect(text).toContain('Press Enter or X again to sign out openai.');
      expect(text).toContain('/subscription login <provider> start');
      expect(manager.get('openai')).not.toBeNull();
      expect(panel.handleInput('enter')).toBe(true);
      text = linesText(panel.render(110, 16));
      expect(manager.get('openai')).toBeNull();
      expect(text).toContain('Ready for login');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
