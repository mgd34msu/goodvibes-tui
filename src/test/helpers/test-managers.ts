import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BookmarkManager } from '../../bookmarks/manager.ts';
import { ConfigManager } from '../../config/manager.ts';
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
  readonly subscriptionManager: SubscriptionManager;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  readonly panelManager: PanelManager;
  readonly bookmarkManager: BookmarkManager;
  readonly toolLLM: ToolLLM;
}

export function createTestManagers(): TestManagers {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const configDir = join(tmpdir(), `gv-config-${suffix}`);
  const subscriptionsPath = join(tmpdir(), `gv-subscriptions-${suffix}.json`);
  const bookmarksDir = join(tmpdir(), `gv-bookmarks-${suffix}`);
  const providerDataDir = join(tmpdir(), `gv-provider-data-${suffix}`);

  const configManager = new ConfigManager({ configDir });
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const favoritesStore = new FavoritesStore({ dir: providerDataDir });
  const benchmarkStore = new BenchmarkStore({ dir: providerDataDir });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager,
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
    subscriptionManager,
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
