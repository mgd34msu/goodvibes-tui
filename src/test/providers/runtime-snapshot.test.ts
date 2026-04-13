import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { FavoritesStore } from '../../providers/favorites.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SubscriptionManager } from '../../config/subscriptions.ts';
import { BenchmarkStore } from '../../providers/model-benchmarks.ts';
import { CacheHitTracker } from '../../providers/cache-strategy.ts';
import { ProviderCapabilityRegistry } from '../../providers/capabilities.ts';
import { ProviderRegistry } from '../../providers/registry.ts';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot } from '../../providers/runtime-snapshot.ts';

function jsonRef(value: unknown): string {
  return `secretref:${JSON.stringify(value)}`;
}

describe('provider runtime snapshots', () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  let root = '';
  let secrets: SecretsManager;
  let subscriptions: SubscriptionManager;
  let providerRegistry: ProviderRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-provider-runtime-'));
    process.env.HOME = root;
    process.chdir(root);
    secrets = new SecretsManager({ projectRoot: root, globalHome: root });
    subscriptions = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: secrets,
      subscriptionManager: subscriptions,
    });
    const favoritesStore = new FavoritesStore({ dir: join(root, '.goodvibes', 'tui') });
    const benchmarkStore = new BenchmarkStore({ dir: join(root, '.goodvibes', 'tui') });
    providerRegistry = new ProviderRegistry({
      configManager: new ConfigManager({ configDir: join(root, '.goodvibes', 'tui') }),
      subscriptionManager: subscriptions,
      secretsManager: secrets,
      serviceRegistry,
      capabilityRegistry: new ProviderCapabilityRegistry(),
      cacheHitTracker: new CacheHitTracker(),
      favoritesStore,
      benchmarkStore,
    });
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  test('surfaces provider-owned secret-ref and subscription OAuth routes', async () => {
    await secrets.set('OPENAI_API_KEY', jsonRef({ source: 'goodvibes', id: 'OPENAI_REAL_KEY' }), {
      scope: 'project',
      medium: 'secure',
    });
    await secrets.set('OPENAI_REAL_KEY', 'sk-linked', {
      scope: 'project',
      medium: 'secure',
    });
    subscriptions.saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const snapshot = await getProviderRuntimeSnapshot(providerRegistry, 'openai');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.runtime.auth?.routes?.some((route) => route.route === 'secret-ref' && route.configured)).toBe(true);
    expect(snapshot?.runtime.auth?.routes?.some((route) => route.route === 'subscription-oauth' && route.configured)).toBe(true);

    const usage = await getProviderUsageSnapshot(providerRegistry, 'openai');
    expect(usage).not.toBeNull();
    expect(usage?.providerId).toBe('openai');
    expect(usage?.usage.streaming).toBe(true);
  });
});
