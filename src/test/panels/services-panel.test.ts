import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { ServicesPanel } from '../../panels/services-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('ServicesPanel', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let root: string;
  let filePath: string;
  let registry: ServiceRegistry;
  let subscriptionManager: SubscriptionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-services-panel-'));
    process.env.HOME = root;
    process.chdir(root);
    filePath = join(root, '.goodvibes', 'tui', 'services.json');
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      slack: {
        name: 'Slack',
        baseUrl: 'https://slack.test/api',
        authType: 'bearer',
        tokenKey: 'SLACK_BOT_TOKEN',
        webhookUrlKey: 'SLACK_WEBHOOK_URL',
        signingSecretKey: 'SLACK_SIGNING_SECRET',
      },
    }), 'utf-8');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/example';
    process.env.SLACK_SIGNING_SECRET = 'secret';
    subscriptionManager = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
    registry = new ServiceRegistry(filePath, {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager,
    });
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_SIGNING_SECRET;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
    mock.restore();
  });

  test('renders configured service details', async () => {
    const panel = new ServicesPanel(registry, subscriptionManager);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = linesText(panel.render(120, 14));
    expect(text).toContain('Service Control Room');
    expect(text).toContain('slack');
    expect(text).toContain('CONFIGURED');
    expect(text).toContain('Primary credential: present');
  });

  test('runs connection tests for the selected service', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const panel = new ServicesPanel(registry, subscriptionManager);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(panel.handleInput('t')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const text = linesText(panel.render(120, 14));
      expect(text).toContain('HEALTHY');
      expect(text).toContain('Last test: ok');
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shows oauth-backed provider overrides in auth summary', async () => {
    writeFileSync(filePath, JSON.stringify({
      openai: {
        name: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        authType: 'oauth',
        tokenKey: 'OPENAI_API_KEY',
        providerId: 'openai',
        oauth: {
          authUrl: 'https://auth.openai.test/authorize',
          tokenUrl: 'https://auth.openai.test/token',
          clientId: 'openai-client',
          redirectUri: 'http://127.0.0.1/callback',
        },
      },
    }), 'utf-8');
    subscriptionManager = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
    subscriptionManager.saveSubscription({
      provider: 'openai',
      accessToken: 'oauth-openai-token',
      tokenType: 'Bearer',
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    registry = new ServiceRegistry(filePath, {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager,
    });
    const panel = new ServicesPanel(registry, subscriptionManager);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = linesText(panel.render(120, 14));
    expect(text).toContain('oauth(active)');
  });
});
