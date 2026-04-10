import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetSecretsManagerForTesting, getSecretsManager } from '../../config/secrets.ts';
import { _resetServiceRegistryForTesting } from '../../config/service-registry.ts';
import { _resetSubscriptionManagerForTesting, getSubscriptionManager } from '../../config/subscriptions.ts';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot } from '../../providers/runtime-snapshot.ts';
import { _resetProviderRegistryForTesting } from '../../providers/registry.ts';

function jsonRef(value: unknown): string {
  return `secretref:${JSON.stringify(value)}`;
}

describe('provider runtime snapshots', () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-provider-runtime-'));
    process.env.HOME = root;
    process.chdir(root);
    _resetSecretsManagerForTesting();
    _resetServiceRegistryForTesting();
    _resetSubscriptionManagerForTesting();
    _resetProviderRegistryForTesting();
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    _resetSecretsManagerForTesting();
    _resetServiceRegistryForTesting();
    _resetSubscriptionManagerForTesting();
    _resetProviderRegistryForTesting();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  test('surfaces provider-owned secret-ref and subscription OAuth routes', async () => {
    const secrets = getSecretsManager();
    await secrets.set('OPENAI_API_KEY', jsonRef({ source: 'goodvibes', id: 'OPENAI_REAL_KEY' }), {
      scope: 'project',
      medium: 'secure',
    });
    await secrets.set('OPENAI_REAL_KEY', 'sk-linked', {
      scope: 'project',
      medium: 'secure',
    });
    getSubscriptionManager().saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const snapshot = await getProviderRuntimeSnapshot('openai');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.runtime.auth?.routes?.some((route) => route.route === 'secret-ref' && route.configured)).toBe(true);
    expect(snapshot?.runtime.auth?.routes?.some((route) => route.route === 'subscription-oauth' && route.configured)).toBe(true);

    const usage = await getProviderUsageSnapshot('openai');
    expect(usage).not.toBeNull();
    expect(usage?.providerId).toBe('openai');
    expect(usage?.usage.streaming).toBe(true);
  });
});
