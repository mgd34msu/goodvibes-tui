import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetSecretsManagerForTesting } from '../../config/secrets.ts';
import { _resetServiceRegistryForTesting } from '../../config/service-registry.ts';
import { _resetSubscriptionManagerForTesting } from '../../config/subscriptions.ts';
import { _resetProviderRegistryForTesting, getProviderRegistry } from '../../providers/registry.ts';

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

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'gv-provider-expansion-'));
    process.env.HOME = tempHome;
    for (const key of CLEAN_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    _resetSecretsManagerForTesting();
    _resetServiceRegistryForTesting();
    _resetSubscriptionManagerForTesting();
    _resetProviderRegistryForTesting();
  });

  afterEach(() => {
    for (const key of CLEAN_ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    _resetSecretsManagerForTesting();
    _resetServiceRegistryForTesting();
    _resetSubscriptionManagerForTesting();
    _resetProviderRegistryForTesting();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test('registers all approved builtin provider and gateway integrations', () => {
    const registry = getProviderRegistry();
    const providerIds = new Set(registry.listProviders().map((provider) => provider.name));
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
    const registry = getProviderRegistry();
    expect(registry.getRegistered('copilot').name).toBe('github-copilot');
    expect(registry.getRegistered('azure-openai').name).toBe('microsoft-foundry');
    expect(registry.getRegistered('dashscope').name).toBe('qwen');
    expect(registry.getRegistered('volcano-engine').name).toBe('volcengine');
    expect(registry.getRegistered('x-ai').name).toBe('xai');
    expect(registry.getRegistered('z-ai').name).toBe('zai');
    expect(registry.getRegistered('cloudflare-gateway').name).toBe('cloudflare-ai-gateway');
    expect(registry.getRegistered('ai-gateway').name).toBe('vercel-ai-gateway');
  });

  test('surfaces runtime auth and policy metadata for new custom and gateway providers', async () => {
    const registry = getProviderRegistry();

    const bedrockProvider = registry.getRegistered('amazon-bedrock');
    expect(bedrockProvider.describeRuntime).toBeDefined();
    const bedrockRuntime = await bedrockProvider.describeRuntime!();
    expect(bedrockRuntime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);
    expect(bedrockRuntime.policy?.streamProtocol).toBe('anthropic-sdk-stream');

    const vertexProvider = registry.getRegistered('anthropic-vertex');
    expect(vertexProvider.describeRuntime).toBeDefined();
    const vertexRuntime = await vertexProvider.describeRuntime!();
    expect(vertexRuntime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);
    expect(vertexRuntime.policy?.streamProtocol).toBe('anthropic-sdk-stream');

    const copilotProvider = registry.getRegistered('github-copilot');
    expect(copilotProvider.describeRuntime).toBeDefined();
    const copilotRuntime = await copilotProvider.describeRuntime!();
    expect(copilotRuntime.auth?.envVars).toContain('GH_TOKEN');
    expect(copilotRuntime.models?.aliases).toContain('copilot');

    const litellmProvider = registry.getRegistered('litellm');
    expect(litellmProvider.describeRuntime).toBeDefined();
    const litellmRuntime = await litellmProvider.describeRuntime!();
    expect(litellmRuntime.auth?.mode).toBe('anonymous');
    expect(litellmRuntime.auth?.configured).toBe(true);
    expect(litellmRuntime.auth?.routes?.some((route) => route.route === 'anonymous')).toBe(true);

    const xaiProvider = registry.getRegistered('xai');
    expect(xaiProvider.describeRuntime).toBeDefined();
    const xaiRuntime = await xaiProvider.describeRuntime!();
    expect(xaiRuntime.models?.defaultModel).toBe('grok-4');
    expect(xaiRuntime.models?.aliases).toContain('x-ai');
  });
});
