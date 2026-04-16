import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProviderAccountSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import { createTestManagers } from '../helpers/test-managers.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SecretsManager } from '../../config/secrets.ts';

describe('provider account snapshot', () => {
  const originalHome = process.env.HOME;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalCwd = process.cwd();
  let root = '';
  let testManagers = createTestManagers();

  beforeEach(() => {
    testManagers = createTestManagers();
    root = mkdtempSync(join(tmpdir(), 'gv-provider-accounts-'));
    process.env.HOME = root;
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  test('marks expired subscription fallback to API key explicitly', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    testManagers.subscriptionManager.saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 5_000,
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
    });

    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: testManagers.subscriptionManager,
    });
    const snapshot = await buildProviderAccountSnapshot({
      providerRegistry: testManagers.providerRegistry,
      serviceRegistry,
      subscriptionManager: testManagers.subscriptionManager,
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
    });
    const openai = snapshot.providers.find((entry) => entry.providerId === 'openai');
    expect(openai).toBeDefined();
    expect(openai?.preferredRoute).toBe('subscription');
    expect(openai?.activeRoute).toBe('api-key');
    expect(openai?.fallbackRoute).toBe('api-key');
    expect(openai?.fallbackRisk).toContain('preferred subscription path');
    expect(openai?.issues.some((issue) => issue.includes('expired'))).toBe(true);
  });

  test('surfaces unusable service OAuth posture as a repair issue', async () => {
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'services.json'), JSON.stringify({
      testsvc: {
        name: 'testsvc',
        providerId: 'test-provider',
        baseUrl: 'https://example.invalid',
        authType: 'oauth',
        tokenKey: 'TEST_PROVIDER_TOKEN',
        oauth: {
          authUrl: 'https://example.invalid/auth',
          tokenUrl: 'https://example.invalid/token',
          clientId: 'client-id',
          redirectUri: 'http://localhost:1455/callback',
        },
      },
    }, null, 2));

    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: testManagers.subscriptionManager,
    });
    const snapshot = await buildProviderAccountSnapshot({
      providerRegistry: testManagers.providerRegistry,
      serviceRegistry,
      subscriptionManager: testManagers.subscriptionManager,
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
    });
    const provider = snapshot.providers.find((entry) => entry.providerId === 'test-provider');
    expect(provider).toBeDefined();
    expect(provider?.oauthReady).toBe(true);
    expect(provider?.activeRoute).toBe('unconfigured');
    expect(provider?.issues.some((issue) => issue.includes('missing a usable credential'))).toBe(true);
    expect(provider?.recommendedActions.some((action) => action.includes('/services'))).toBe(true);
  });
});
