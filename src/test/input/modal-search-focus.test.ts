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
    // Search starts focused by default now (see openAllModels() doc
    // comment) — this test is specifically about hotkey behavior OUTSIDE
    // search, so set up that precondition explicitly.
    picker.blurSearch();

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

  test('model picker uses left and right to switch target/list panes', () => {
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
    // Left/Right pane switching is gated on !searchFocused, and search
    // now starts focused by default (see openAllModels() doc comment).
    picker.blurSearch();

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, { type: 'key', name: 'left', logicalName: 'left', ctrl: false, shift: false, meta: false });
    expect(picker.focusPane).toBe('targets');

    handleModelPickerToken(state, { type: 'key', name: 'right', logicalName: 'right', ctrl: false, shift: false, meta: false });
    expect(picker.focusPane).toBe('items');
    expect(picker.selectedIndex).toBe(0);
  });

  test('model picker exposes capability, availability, and benchmark hotkeys outside search', () => {
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
    // This test is specifically "outside search" — search now starts
    // focused by default (see openAllModels() doc comment).
    picker.blurSearch();

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, { type: 'text', value: 'c' });
    expect(picker.capabilityFilter).toBe('reasoning');

    handleModelPickerToken(state, { type: 'text', value: 'a' });
    expect(picker.availableOnly).toBe(false);

    handleModelPickerToken(state, { type: 'text', value: 'b' });
    expect(picker.benchmarkSort).toBe('composite');
  });

  test('model picker appends space to search query when searchFocused — no context-cap hijack', () => {
    // Regression test for #21: space while searchFocused must go to query even
    // when the highlighted item is a local model.
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
    picker.searchFocused = true;

    const state = {
      modelPicker: picker,
      modalStack: [] as string[],
      commandContext: undefined as never,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, { type: 'text', value: ' ' });
    // Space must go to query, not trigger contextCap mode
    expect(picker.mode).toBe('model');
    expect(picker.query).toBe(' ');
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
    // The whole word reached the query — none of it was hijacked by the
    // c/a hotkeys (capabilityFilter/availableOnly must be untouched).
    expect(picker.query).toBe('claude');
    expect(picker.capabilityFilter).toBe('none');
    expect(picker.availableOnly).toBe(true);
    expect(picker.getFilteredModels().map((m) => m.id)).toEqual(['claude-1']);
  });
});
