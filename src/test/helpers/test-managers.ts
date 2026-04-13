import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BookmarkManager } from '../../bookmarks/manager.ts';
import { ConfigManager } from '../../config/manager.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { FavoritesStore } from '../../providers/favorites.ts';
import { BenchmarkStore } from '../../providers/model-benchmarks.ts';
import { SubscriptionManager } from '../../config/subscriptions.ts';
import { ToolLLM } from '../../config/tool-llm.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { ProviderCapabilityRegistry } from '../../providers/capabilities.ts';
import { CacheHitTracker } from '../../providers/cache-strategy.ts';
import { ProviderRegistry } from '../../providers/registry.ts';

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

  const configManager = new ConfigManager({ configDir, workingDir, homeDir });
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
