import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers';
import { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import { PanelManager } from '../../panels/panel-manager.ts';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { LLMProvider, ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';

export interface TestManagers {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  readonly panelManager: PanelManager;
  readonly bookmarkManager: BookmarkManager;
  readonly toolLLM: ToolLLM;
}

export function buildTestModelDefinition(provider: string, modelId: string): ModelDefinition {
  return {
    id: modelId,
    provider,
    registryKey: `${provider}:${modelId}`,
    displayName: modelId,
    description: 'Test model',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 4096,
    selectable: true,
    tier: 'standard',
  };
}

export function patchTestProviderRegistry(providerRegistry: ProviderRegistry): void {
  const originalRegister = providerRegistry.register.bind(providerRegistry);
  providerRegistry.register = ((provider: LLMProvider): void => {
    originalRegister(provider);
    if (provider.models.length === 0) return;
    providerRegistry.registerRuntimeProvider({
      provider,
      replace: true,
      models: provider.models.map((modelId) => buildTestModelDefinition(provider.name, modelId)),
    });
  }) as ProviderRegistry['register'];
}

export function createTestManagers(): TestManagers {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const rootDir = join(tmpdir(), `gv-test-managers-${suffix}`);
  const workingDir = join(rootDir, 'workspace');
  const homeDir = join(rootDir, 'home');
  const configDir = join(homeDir, '.goodvibes', 'tui');
  const subscriptionsPath = join(rootDir, 'subscriptions.json');
  const servicesPath = join(rootDir, 'services.json');
  const bookmarksDir = join(rootDir, 'bookmarks');
  const providerDataDir = join(rootDir, 'provider-data');

  const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir, homeDir });
  // Enable tools.llmEnabled by default in tests so resolveToolLLM tests can exercise
  // the resolution logic without each test individually opting in. Production code
  // keeps the gate off by default; tests opt in so the gate is not the thing under test.
  configManager.set('tools.llmEnabled', true);
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const secretsManager = new SecretsManager({ projectRoot: workingDir, globalHome: homeDir });
  const serviceRegistry = new ServiceRegistry(servicesPath, {
    secretsManager,
    subscriptionManager,
  });
  const favoritesStore = new FavoritesStore({ dir: providerDataDir });
  const benchmarkStore = new BenchmarkStore({ dir: providerDataDir });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: new ProviderCapabilityRegistry(),
    cacheHitTracker: new CacheHitTracker(),
    favoritesStore,
    benchmarkStore,
  });
  patchTestProviderRegistry(providerRegistry);
  const panelManager = new PanelManager();
  const bookmarkManager = new BookmarkManager(bookmarksDir);
  const toolLLM = new ToolLLM({ configManager, providerRegistry });

  return {
    configManager,
    secretsManager,
    subscriptionManager,
    serviceRegistry,
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    panelManager,
    bookmarkManager,
    toolLLM,
  };
}

export function createTestConfigManager(): ConfigManager {
  return createTestManagers().configManager;
}

export function createTestProviderRegistry(): ProviderRegistry {
  return createTestManagers().providerRegistry;
}

export function createTestBookmarkManager(): BookmarkManager {
  return createTestManagers().bookmarkManager;
}

export function createTestPanelManager(): PanelManager {
  return createTestManagers().panelManager;
}
