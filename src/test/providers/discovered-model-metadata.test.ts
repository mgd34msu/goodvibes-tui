import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PricingCatalog } from '../../providers/model-catalog.ts';
import { _resetForTest, _setCatalogForTesting } from '../../providers/model-catalog.ts';
import { _resetProviderRegistryForTesting, getModelRegistry, getProviderRegistry } from '../../providers/registry.ts';
import type { DiscoveredServer } from '../../discovery/scanner.ts';

const MINIMAL_CATALOG: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [],
};

describe('discovered model metadata', () => {
  beforeEach(() => {
    _resetForTest();
    _resetProviderRegistryForTesting();
    _setCatalogForTesting(MINIMAL_CATALOG);
  });

  afterEach(() => {
    _resetForTest();
    _resetProviderRegistryForTesting();
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

    getProviderRegistry().registerDiscoveredProviders([server]);
    const model = getModelRegistry().find((entry) => entry.registryKey === 'LM Studio:qwen3-thinking');

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

    const registry = getProviderRegistry();
    registry.registerDiscoveredProviders([server]);
    const model = getModelRegistry().find((entry) => entry.registryKey === 'Ollama:qwen3');
    const provider = registry.get('Ollama');

    expect(model?.capabilities.reasoning).toBe(true);
    expect(model?.reasoningEffort).toEqual(['instant', 'low', 'medium', 'high']);
    expect(provider.capabilities?.toolCalling).toBe(true);
    expect(provider.capabilities?.reasoningControls).toBe(true);
  });
});
