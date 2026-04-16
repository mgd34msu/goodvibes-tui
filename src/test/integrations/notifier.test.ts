import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { Notifier } from '@pellux/goodvibes-sdk/platform/integrations/notifier';

describe('Notifier.fromConfig', () => {
  let root: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'gv-notifier-'));
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'services.json'), JSON.stringify({
      slack: {
        name: 'Slack',
        baseUrl: 'https://slack.com/api',
        authType: 'bearer',
        tokenKey: 'SLACK_BOT_TOKEN',
        webhookUrlKey: 'SLACK_WEBHOOK_URL',
      },
      discord: {
        name: 'Discord',
        baseUrl: 'https://discord.com/api',
        authType: 'bearer',
        tokenKey: 'DISCORD_BOT_TOKEN',
        webhookUrlKey: 'DISCORD_WEBHOOK_URL',
      },
    }), 'utf-8');
    process.chdir(root);
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/example';
    process.env.DISCORD_BOT_TOKEN = 'discord-test-token';
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    rmSync(root, { recursive: true, force: true });
  });

  test('builds active channels from service registry and env-backed secrets', async () => {
    const notifier = await Notifier.fromConfig(new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json')),
    }));
    const channels = notifier.getQueueStatus().map((entry) => entry.channel).sort();
    expect(channels).toEqual(['discord', 'slack']);
  });
});
