import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers';
import { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface PickerHarness {
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  cleanup(): void;
}

function createPickerHarness(): PickerHarness {
  const rootDir = makeProjectTempDir('gv-modal-search-focus');
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
    configManager: new ConfigManager({ surfaceRoot: 'tui',
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
  test('selection modal: a claimed action letter fires while the query is empty; once typing, it is a character', () => {
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
    handleSelectionModalToken(state, { type: 'text', value: 't' });
    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).toBeNull();
    expect(modal.query).toBe('td');
  });

  test('selection modal: up/down always move the selection (there is no search mode to enter)', () => {
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

    handleSelectionModalToken(state, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(1);
    handleSelectionModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(0);
    handleSelectionModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(1); // wraps
  });

  test('model picker: letters always type into the live search; ctrl+g cycles the grouping', () => {
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
    expect(picker.query).toBe('g');
    expect(picker.groupBy).toBe('provider');
    handleModelPickerToken(state, { type: 'key', name: 'g', logicalName: 'g', ctrl: true, shift: false, meta: false });
    expect(picker.groupBy).toBe('family');
  });

  test('model picker: left/right and tab/shift+tab switch the target tab', () => {
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
    picker.setTargetInfos([
      { target: 'main', label: 'Main Chat', description: '', provider: 'openai', model: 'openai:gpt-1', enabled: true, inherited: false },
      { target: 'helper', label: 'Helper', description: '', provider: 'openai', model: 'openai:gpt-1', enabled: true, inherited: false },
    ]);
    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, { type: 'key', name: 'right', logicalName: 'right', ctrl: false, shift: false, meta: false });
    expect(picker.target).toBe('helper');
    handleModelPickerToken(state, { type: 'key', name: 'left', logicalName: 'left', ctrl: false, shift: false, meta: false });
    expect(picker.target).toBe('main');
    handleModelPickerToken(state, { type: 'key', name: 'tab', logicalName: 'tab', ctrl: false, shift: false, meta: false });
    expect(picker.target).toBe('helper');
    handleModelPickerToken(state, { type: 'key', name: 'tab', logicalName: 'tab', ctrl: false, shift: true, meta: false });
    expect(picker.target).toBe('main');
  });

  test('model picker: capability, availability and benchmark filters are ctrl chords that work while typing', () => {
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

    handleModelPickerToken(state, { type: 'text', value: 'g' });
    handleModelPickerToken(state, { type: 'key', name: 'k', logicalName: 'k', ctrl: true, shift: false, meta: false });
    expect(picker.capabilityFilter).toBe('reasoning');
    handleModelPickerToken(state, { type: 'key', name: 'a', logicalName: 'a', ctrl: true, shift: false, meta: false });
    expect(picker.availableOnly).toBe(false);
    handleModelPickerToken(state, { type: 'key', name: 'b', logicalName: 'b', ctrl: true, shift: false, meta: false });
    expect(picker.benchmarkSort).not.toBe('none');
    handleModelPickerToken(state, { type: 'key', name: 't', logicalName: 't', ctrl: true, shift: false, meta: false });
    expect(picker.categoryFilter).toBe('free');
    // The typed query was never disturbed.
    expect(picker.query).toBe('g');
  });

  test('model picker: once typing has started, space is query text (no context-cap hijack); on an untouched search it sets a local model\'s cap', () => {
    // Regression #21: space while typing must go to the query even when the
    // highlighted item is a local model.
    const local: Parameters<typeof ModelPickerModal.prototype.openAllModels>[0][0] = {
      id: 'local-1',
      provider: 'ollama',
      registryKey: 'ollama:local-1',
      displayName: 'Local 1',
      description: '',
      capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: 4096,
      contextWindowProvenance: 'provider_api',
      selectable: true,
      tier: 'free',
    };
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.openAllModels([local], local.id!);

    const state = {
      modelPicker: picker,
      modalStack: [] as string[],
      commandContext: undefined as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, { type: 'text', value: 'l' });
    handleModelPickerToken(state, { type: 'text', value: ' ' });
    expect(picker.mode).toBe('model');
    expect(picker.query).toBe('l ');

    picker.clearQuery();
    handleModelPickerToken(state, { type: 'text', value: ' ' });
    expect(picker.mode).toBe('contextCap');
  });

  test('W3-T2: opening /model and immediately typing a search term filters the list, instead of silently hitting hotkeys', () => {
    // Live tmux repro (session cc-w3-t2) of the exact reported friction: with
    // search unfocused by default, typing e.g. "claude" went character-by-
    // character into single-key shortcuts (c=capability, a=available-only)
    // while the list never filtered and nothing visibly indicated why. This
    // is the fixed behavior: search starts focused, so every character of a
    // typed search term reaches the query, not a hotkey.
    const models: Parameters<typeof ModelPickerModal.prototype.openAllModels>[0] = [
      {
        id: 'claude-1', provider: 'anthropic', registryKey: 'anthropic:claude-1', displayName: 'Claude One',
        description: '', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
        contextWindow: 200_000, selectable: true, tier: 'premium',
      },
      {
        id: 'gpt-1', provider: 'openai', registryKey: 'openai:gpt-1', displayName: 'GPT 1',
        description: '', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 8192, selectable: true, tier: 'premium',
      },
    ];
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.openAllModels(models, 'gpt-1');

    const state = {
      modelPicker: picker,
      modalStack: [] as string[],
      commandContext: undefined as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    expect(picker.searchFocused).toBe(true);
    for (const ch of 'claude') {
      handleModelPickerToken(state, { type: 'text', value: ch });
    }
    // The whole word reached the query, none of it was hijacked by the
    // c/a hotkeys (capabilityFilter/availableOnly must be untouched).
    expect(picker.query).toBe('claude');
    expect(picker.capabilityFilter).toBe('none');
    expect(picker.availableOnly).toBe(true);
    expect(picker.getFilteredModels().map((m) => m.id)).toEqual(['claude-1']);
  });
});
