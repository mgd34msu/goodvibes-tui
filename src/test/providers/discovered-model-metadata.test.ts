import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PricingCatalog } from '@pellux/goodvibes-sdk/platform/providers';
import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery';
import { createTestManagers } from '../helpers/test-managers.ts';
import { createProviderCacheFixture, writeModelCatalogCache } from '../helpers/provider-cache.ts';

const MINIMAL_CATALOG: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [],
};

describe('discovered model metadata', () => {
  let testManagers: ReturnType<typeof createTestManagers>;
  let cacheFixture: ReturnType<typeof createProviderCacheFixture>;

  function loadCatalog(models: PricingCatalog['models']): void {
    writeModelCatalogCache(models, cacheFixture.cacheDir, MINIMAL_CATALOG.fetchedAt);
    testManagers.providerRegistry.initCatalog();
  }

  beforeEach(() => {
    testManagers = createTestManagers();
    cacheFixture = createProviderCacheFixture(testManagers.configManager.getControlPlaneConfigDir());
    loadCatalog(MINIMAL_CATALOG.models);
    testManagers.providerRegistry.registerDiscoveredProviders([]);
  });

  afterEach(() => {
    cacheFixture.restoreEnv();
    cacheFixture.cleanup();
    testManagers.providerRegistry.registerDiscoveredProviders([]);
  });

  test('LM Studio discovered models advertise reasoning support and effort levels', () => {
    const server: DiscoveredServer = {
      name: 'LM Studio',
      host: '127.0.0.1',
      port: 1234,
      baseURL: 'http://127.0.0.1:1234/v1',
      models: ['qwen3-thinking'],
      serverType: 'lm-studio',
      modelContextWindows: { 'qwen3-thinking': 65536 },
    };

    testManagers.providerRegistry.registerDiscoveredProviders([server]);
    const model = testManagers.providerRegistry.listModels().find((entry) => entry.registryKey === 'LM Studio:qwen3-thinking');

    expect(model?.capabilities.reasoning).toBe(true);
    expect(model?.reasoningEffort).toEqual(['instant', 'low', 'medium', 'high']);
  });

  test('Ollama discovered models advertise reasoning support and OAI compat fallback stays available', () => {
    const server: DiscoveredServer = {
      name: 'Ollama',
      host: '127.0.0.1',
      port: 11434,
      baseURL: 'http://127.0.0.1:11434/v1',
      models: ['qwen3'],
      serverType: 'ollama',
      modelContextWindows: { qwen3: 32768 },
    };

    const registry = testManagers.providerRegistry;
    registry.registerDiscoveredProviders([server]);
    const model = registry.listModels().find((entry) => entry.registryKey === 'Ollama:qwen3');
    const provider = registry.get('Ollama');
    if (!provider) throw new Error('Expected discovered Ollama provider');

    expect(model?.capabilities.reasoning).toBe(true);
    expect(model?.reasoningEffort).toEqual(['instant', 'low', 'medium', 'high']);
    expect(provider.capabilities?.toolCalling).toBe(true);
    expect(provider.capabilities?.reasoningControls).toBe(true);
  });
});
