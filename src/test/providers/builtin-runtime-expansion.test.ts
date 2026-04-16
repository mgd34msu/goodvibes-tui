import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers/capabilities';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';

const CLEAN_ENV_KEYS = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
];

describe('provider runtime expansion', () => {
  const originalHome = process.env.HOME;
  const originalEnv = new Map<string, string | undefined>();
  let tempHome = '';
  let providerRegistry: ProviderRegistry;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'gv-provider-expansion-'));
    process.env.HOME = tempHome;
    for (const key of CLEAN_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(tempHome, '.goodvibes', 'tui') });
    const subscriptionManager = new SubscriptionManager(join(tempHome, '.goodvibes', 'tui', 'subscriptions.json'));
    const secretsManager = new SecretsManager({ projectRoot: tempHome, globalHome: tempHome });
    const serviceRegistry = new ServiceRegistry(join(tempHome, '.goodvibes', 'tui', 'services.json'), {
      secretsManager,
      subscriptionManager,
    });
    const favoritesStore = new FavoritesStore({ dir: join(tempHome, '.goodvibes', 'tui') });
    const benchmarkStore = new BenchmarkStore({ dir: join(tempHome, '.goodvibes', 'tui') });
    providerRegistry = new ProviderRegistry({
      configManager,
      subscriptionManager,
      secretsManager,
      serviceRegistry,
      capabilityRegistry: new ProviderCapabilityRegistry(),
      cacheHitTracker: new CacheHitTracker(),
      favoritesStore,
      benchmarkStore,
    });
  });

  afterEach(() => {
    for (const key of CLEAN_ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test('registers all approved builtin provider and gateway integrations', () => {
    const providerIds = new Set(providerRegistry.listProviders().map((provider) => provider.name));
    for (const providerId of [
      'amazon-bedrock',
      'amazon-bedrock-mantle',
      'anthropic-vertex',
      'deepseek',
      'fireworks',
      'github-copilot',
      'microsoft-foundry',
      'minimax',
      'moonshot',
      'qianfan',
      'qwen',
      'sglang',
      'stepfun',
      'together',
      'venice',
      'volcengine',
      'xai',
      'xiaomi',
      'zai',
      'cloudflare-ai-gateway',
      'vercel-ai-gateway',
      'litellm',
      'copilot-proxy',
    ]) {
      expect(providerIds.has(providerId)).toBe(true);
    }
  });

  test('resolves builtin provider aliases through the registry', () => {
    expect(providerRegistry.getRegistered('copilot').name).toBe('github-copilot');
    expect(providerRegistry.getRegistered('azure-openai').name).toBe('microsoft-foundry');
    expect(providerRegistry.getRegistered('dashscope').name).toBe('qwen');
    expect(providerRegistry.getRegistered('volcano-engine').name).toBe('volcengine');
    expect(providerRegistry.getRegistered('x-ai').name).toBe('xai');
    expect(providerRegistry.getRegistered('z-ai').name).toBe('zai');
    expect(providerRegistry.getRegistered('cloudflare-gateway').name).toBe('cloudflare-ai-gateway');
    expect(providerRegistry.getRegistered('ai-gateway').name).toBe('vercel-ai-gateway');
  });

  test('surfaces runtime auth and policy metadata for new custom and gateway providers', async () => {
    const bedrockProvider = providerRegistry.getRegistered('amazon-bedrock');
    expect(bedrockProvider.describeRuntime).toBeDefined();
    const bedrockRuntime = await providerRegistry.describeRuntime('amazon-bedrock');
    expect(bedrockRuntime).not.toBeNull();
    if (!bedrockRuntime) throw new Error('amazon-bedrock runtime metadata missing');
    expect(bedrockRuntime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);
    expect(bedrockRuntime.policy?.streamProtocol).toBe('anthropic-sdk-stream');

    const vertexProvider = providerRegistry.getRegistered('anthropic-vertex');
    expect(vertexProvider.describeRuntime).toBeDefined();
    const vertexRuntime = await providerRegistry.describeRuntime('anthropic-vertex');
    expect(vertexRuntime).not.toBeNull();
    if (!vertexRuntime) throw new Error('anthropic-vertex runtime metadata missing');
    expect(vertexRuntime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);
    expect(vertexRuntime.policy?.streamProtocol).toBe('anthropic-sdk-stream');

    const copilotProvider = providerRegistry.getRegistered('github-copilot');
    expect(copilotProvider.describeRuntime).toBeDefined();
    const copilotRuntime = await providerRegistry.describeRuntime('github-copilot');
    expect(copilotRuntime).not.toBeNull();
    if (!copilotRuntime) throw new Error('github-copilot runtime metadata missing');
    expect(copilotRuntime.auth?.envVars).toContain('GH_TOKEN');
    expect(copilotRuntime.models?.aliases).toContain('copilot');

    const litellmProvider = providerRegistry.getRegistered('litellm');
    expect(litellmProvider.describeRuntime).toBeDefined();
    const litellmRuntime = await providerRegistry.describeRuntime('litellm');
    expect(litellmRuntime).not.toBeNull();
    if (!litellmRuntime) throw new Error('litellm runtime metadata missing');
    expect(litellmRuntime.auth?.mode).toBe('anonymous');
    expect(litellmRuntime.auth?.configured).toBe(true);
    expect(litellmRuntime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);

    const xaiProvider = providerRegistry.getRegistered('xai');
    expect(xaiProvider.describeRuntime).toBeDefined();
    const xaiRuntime = await providerRegistry.describeRuntime('xai');
    expect(xaiRuntime).not.toBeNull();
    if (!xaiRuntime) throw new Error('xai runtime metadata missing');
    expect(xaiRuntime.models?.defaultModel).toBe('grok-4');
    expect(xaiRuntime.models?.aliases).toContain('x-ai');
  });
});
