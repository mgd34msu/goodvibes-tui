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
      panel.handleInput('down');
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

  async function makeActivePanelWithOpenai() {
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
    } finally {
      globalThis.fetch = originalFetch;
    }
    const panel = new SubscriptionPanel(serviceRegistry, subscriptionManager);
    panel.onActivate();
    return panel;
  }

  test('Enter triggers confirm prompt (ConfirmState); session still active before confirm', async () => {
    const panel = await makeActivePanelWithOpenai();
    expect(panel.handleInput('enter')).toBe(true);
    const text = linesText(panel.render(110, 16));
    expect(text).toContain('Sign out openai?');
    expect(subscriptionManager.get('openai')).not.toBeNull();
  });

  test('y confirms sign-out after Enter prompt', async () => {
    const panel = await makeActivePanelWithOpenai();
    panel.handleInput('enter'); // prompt
    expect(panel.handleInput('y')).toBe(true);
    expect(subscriptionManager.get('openai')).toBeNull();
    const text = linesText(panel.render(110, 16));
    expect(text).toContain('Ready for login');
  });

  test('Enter confirms sign-out after Enter prompt (Enter/y both confirm)', async () => {
    const panel = await makeActivePanelWithOpenai();
    panel.handleInput('enter'); // prompt
    expect(panel.handleInput('enter')).toBe(true);
    expect(subscriptionManager.get('openai')).toBeNull();
  });

  test('n cancels sign-out and keeps subscription active', async () => {
    const panel = await makeActivePanelWithOpenai();
    panel.handleInput('enter'); // prompt
    expect(panel.handleInput('n')).toBe(true);
    expect(subscriptionManager.get('openai')).not.toBeNull();
    const text = linesText(panel.render(110, 16));
    expect(text).not.toContain('Sign out openai?');
  });

  test('escape cancels sign-out and keeps subscription active', async () => {
    const panel = await makeActivePanelWithOpenai();
    panel.handleInput('enter'); // prompt
    expect(panel.handleInput('escape')).toBe(true);
    expect(subscriptionManager.get('openai')).not.toBeNull();
  });

  test('other key is absorbed while confirm pending (subscription unchanged)', async () => {
    const panel = await makeActivePanelWithOpenai();
    panel.handleInput('enter'); // prompt
    expect(panel.handleInput('x')).toBe(true); // absorbed — does nothing
    expect(subscriptionManager.get('openai')).not.toBeNull();
    // confirm still pending
    const text = linesText(panel.render(110, 16));
    expect(text).toContain('Sign out openai?');
  });

  test('navigation is absorbed while confirm pending (confirm stays active)', async () => {
    const panel = await makeActivePanelWithOpenai();
    panel.handleInput('enter'); // prompt
    // down is absorbed while confirm is pending (project-standard: only Enter/y/n/Esc are routed)
    expect(panel.handleInput('down')).toBe(true); // absorbed
    const text = linesText(panel.render(110, 16));
    expect(text).toContain('Sign out openai?'); // confirm still pending
  });
});
