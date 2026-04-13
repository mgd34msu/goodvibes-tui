import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../../config/manager.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SubscriptionManager } from '../../config/subscriptions.ts';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { CacheHitTracker } from '../../providers/cache-strategy.ts';
import { ProviderCapabilityRegistry } from '../../providers/capabilities.ts';
import { FavoritesStore } from '../../providers/favorites.ts';
import { BenchmarkStore } from '../../providers/model-benchmarks.ts';
import { ProviderRegistry } from '../../providers/registry.ts';

interface PickerHarness {
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  cleanup(): void;
}

function createPickerHarness(): PickerHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'gv-modal-search-focus-'));
  const configDir = join(rootDir, 'config');
  const dataDir = join(rootDir, 'provider-data');
  const subscriptionsPath = join(rootDir, 'subscriptions.json');
  const servicesPath = join(rootDir, 'services.json');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const secretsManager = new SecretsManager({ projectRoot: rootDir, globalHome: rootDir });
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const serviceRegistry = new ServiceRegistry(servicesPath, {
    secretsManager,
    subscriptionManager,
  });
  const favoritesStore = new FavoritesStore({ dir: dataDir });
  const benchmarkStore = new BenchmarkStore({ dir: dataDir });
  writeFileSync(favoritesStore.getPath(), JSON.stringify({ pinned: [], history: [] }, null, 2));
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({ version: 1 as const, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }, null, 2),
  );
  benchmarkStore.initBenchmarks();

  const providerRegistry = new ProviderRegistry({
    configManager: new ConfigManager({
      configDir,
      workingDir: rootDir,
      homeDir: rootDir,
    }),
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: new ProviderCapabilityRegistry(),
    cacheHitTracker: new CacheHitTracker(),
    favoritesStore,
    benchmarkStore,
  });

  return {
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

let harness: PickerHarness;

beforeEach(() => {
  harness = createPickerHarness();
});

afterEach(() => {
  harness?.cleanup();
});

describe('modal search focus routing', () => {
  test('selection modal keeps typable custom actions active until search is focused', () => {
    const modal = new SelectionModal();
    const customActions = new Map([['d', 'delete' as const]]);
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true, customActions });

    let result: { item: { id: string }; action: string } | null = null;
    const state = {
      selectionModal: modal,
      selectionCallback: (value: typeof result) => { result = value; },
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('delete');

    result = null;
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true, customActions });
    handleSelectionModalToken(state, { type: 'text', value: '/' });
    expect(modal.searchFocused).toBe(true);
    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).toBeNull();
    expect(modal.query).toBe('d');
  });

  test('selection modal moves into and out of search with up/down', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true });

    const state = {
      selectionModal: modal,
      selectionCallback: null,
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(true);
    handleSelectionModalToken(state, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, shift: false, meta: false });
    expect(modal.searchFocused).toBe(false);
    expect(modal.selectedIndex).toBe(0);
  });

  test('model picker keeps group hotkey active until search is focused', () => {
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.openAllModels([
      {
        id: 'gpt-1',
        provider: 'openai',
        registryKey: 'openai:gpt-1',
        displayName: 'GPT 1',
        description: '',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
        tier: 'premium',
      },
    ], 'gpt-1');

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    expect(picker.groupBy).toBe('provider');
    handleModelPickerToken(state, { type: 'text', value: 'g' });
    expect(picker.groupBy).toBe('family');

    handleModelPickerToken(state, { type: 'text', value: '/' });
    expect(picker.searchFocused).toBe(true);
    handleModelPickerToken(state, { type: 'text', value: 'g' });
    expect(picker.groupBy).toBe('family');
    expect(picker.query).toBe('g');
  });
});
