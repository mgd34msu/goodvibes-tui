/**
 * Tests for ModelPickerModal state class.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelPickerModal, detectFamily, tierToCategoryFilter, POPULAR_PROVIDERS } from '../../input/model-picker.ts';
import type { CategoryFilter, PickerMode } from '../../input/model-picker.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers/capabilities';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import { BenchmarkStore, type BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  const base: ModelDefinition = {
    id: 'test-model',
    provider: 'test-provider',
    registryKey: 'test-provider:test-model',
    displayName: 'Test Model',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'free',
    ...overrides,
  };
  // Ensure registryKey reflects provider:id after overrides
  if (!base.registryKey || base.registryKey === 'test-provider:test-model') {
    base.registryKey = `${base.provider}:${base.id}`;
  }
  return base;
}

const FREE_MODEL = makeModel({ id: 'free-1', displayName: 'Free Model 1', tier: 'free', provider: 'provA' });
const FREE_MODEL_2 = makeModel({ id: 'free-2', displayName: 'Free Model 2', tier: 'free', provider: 'provB' });
const PREMIUM_MODEL = makeModel({ id: 'premium-1', displayName: 'Premium Model', tier: 'premium', provider: 'provA' });
const REASONING_MODEL = makeModel({
  id: 'reasoning-1',
  displayName: 'Reasoning Model',
  tier: 'premium',
  provider: 'provC',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
  reasoningEffort: ['low', 'medium', 'high'],
});

const ALL_MODELS = [FREE_MODEL, FREE_MODEL_2, PREMIUM_MODEL, REASONING_MODEL];

interface PickerHarness {
  readonly rootDir: string;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  cleanup(): void;
}

function writeBenchmarksCache(entries: BenchmarkEntry[], benchmarkStore: BenchmarkStore): void {
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({
      version: 1 as const,
      fetchedAt: Date.now(),
      ttlMs: 86_400_000,
      entries,
    }, null, 2),
  );
}

function createPickerHarness(): PickerHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'gv-model-picker-'));
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
  writeBenchmarksCache([], benchmarkStore);
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
    rootDir,
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

let harness: PickerHarness;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ModelPickerModal', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    harness = createPickerHarness();
    picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
  });

  afterEach(() => {
    harness?.cleanup();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  test('starts inactive with defaults', () => {
    expect(picker.active).toBe(false);
    expect(picker.mode).toBe('model');
    expect(picker.selectedIndex).toBe(0);
    expect(picker.query).toBe('');
    expect(picker.categoryFilter).toBe('all');
  });

  // ── getFilteredModels ──────────────────────────────────────────────────────

  describe('getFilteredModels()', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
    });

    test('returns all models with no filter', () => {
      expect(picker.getFilteredModels()).toHaveLength(4);
    });

    test('filters by free tier', () => {
      picker.categoryFilter = 'free';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(2);
      expect(result.every(m => m.tier === 'free')).toBe(true);
    });

    test('filters by paid tier (premium/standard models)', () => {
      picker.categoryFilter = 'paid';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(2);
      // 'premium' and 'standard' tiers both map to 'paid'
      expect(result.every(m => m.tier === 'premium' || m.tier === 'standard')).toBe(true);
    });

    test('filters by query — matches id', () => {
      picker.query = 'free-1';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('free-1');
    });

    test('filters by query — matches displayName case-insensitive', () => {
      picker.query = 'PREMIUM MODEL';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('premium-1');
    });

    test('filters by query — matches provider', () => {
      picker.query = 'provB';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('free-2');
    });

    test('fuzzy query — all words must match', () => {
      picker.query = 'free provA';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('free-1');
    });

    test('query + category filter combine', () => {
      picker.categoryFilter = 'paid';
      picker.query = 'reasoning';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('reasoning-1');
    });

    test('empty query with whitespace returns all', () => {
      picker.query = '   ';
      expect(picker.getFilteredModels()).toHaveLength(4);
    });

    test('no match returns empty array', () => {
      picker.query = 'zzz-no-match';
      expect(picker.getFilteredModels()).toHaveLength(0);
    });
  });

  // ── getItems ──────────────────────────────────────────────────────────────

  describe('getItems()', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
    });

    test('model mode inserts group headers when provider changes', () => {
      const items = picker.getItems();
      const headers = items.filter(i => i.isGroupHeader);
      // provA, provB, provA (again — not consecutive), provC = 4 headers
      expect(headers.length).toBe(4);
    });

    test('model mode items include both headers and models', () => {
      const items = picker.getItems();
      // 4 models + 4 headers (provA appears twice non-consecutively)
      expect(items.length).toBe(8);
    });

    test('model mode non-header items match model count', () => {
      const items = picker.getItems();
      const nonHeaders = items.filter(i => !i.isGroupHeader);
      expect(nonHeaders.length).toBe(4);
    });

    test('provider mode returns grouped list with headers', () => {
      picker.mode = 'provider';
      // provA and provB are not in POPULAR_PROVIDERS — go to All group
      picker.providers = ['provA', 'provB'];
      picker.configuredProviders = new Set();
      const items = picker.getItems();
      // 1 header (All Providers) + 2 selectable items
      expect(items).toHaveLength(3);
      expect(items[0].isGroupHeader).toBe(true);
      expect(items[0].label).toBe('All Providers');
      expect(items[1].isGroupHeader).toBeFalsy();
    });

    test('provider mode filters list by query (non-header items)', () => {
      picker.mode = 'provider';
      picker.providers = ['anthropic', 'openai', 'gemini'];
      picker.configuredProviders = new Set();
      picker.query = 'open';
      const items = picker.getItems();
      const selectables = items.filter(i => !i.isGroupHeader);
      expect(selectables).toHaveLength(1);
      expect(selectables[0].id).toBe('openai');
    });

    test('provider mode filter is case-insensitive', () => {
      picker.mode = 'provider';
      picker.providers = ['Anthropic', 'OpenAI', 'Gemini'];
      picker.configuredProviders = new Set();
      picker.query = 'ANTHROPIC';
      const items = picker.getItems();
      const selectables = items.filter(i => !i.isGroupHeader);
      expect(selectables).toHaveLength(1);
      expect(selectables[0].id).toBe('Anthropic');
    });

    test('effort mode returns effort levels with descriptions', () => {
      picker.mode = 'effort';
      picker.effortLevels = ['low', 'medium', 'high'];
      const items = picker.getItems();
      expect(items).toHaveLength(3);
      expect(items[0].id).toBe('low');
      expect(items[0].detail).toBeTruthy();
      expect(items[1].detail).toContain('Balanced');
    });

    test('effort mode — unknown level gets empty detail', () => {
      picker.mode = 'effort';
      picker.effortLevels = ['ultra'];
      const items = picker.getItems();
      expect(items[0].detail).toBe('');
    });
  });

  // ── moveUp / moveDown ─────────────────────────────────────────────────────

  describe('moveUp() / moveDown()', () => {
    beforeEach(() => {
      picker.models = [FREE_MODEL, FREE_MODEL_2, PREMIUM_MODEL];
    });

    test('moveDown increments selectedIndex', () => {
      picker.selectedIndex = 0;
      picker.moveDown();
      expect(picker.selectedIndex).toBe(1);
    });

    test('moveDown wraps from last to 0', () => {
      picker.selectedIndex = 2;
      picker.moveDown();
      expect(picker.selectedIndex).toBe(0);
    });

    test('moveUp decrements selectedIndex', () => {
      picker.selectedIndex = 2;
      picker.moveUp();
      expect(picker.selectedIndex).toBe(1);
    });

    test('moveUp at 0 stops at 0 (no off-screen wrap)', () => {
      picker.selectedIndex = 0;
      picker.moveUp();
      expect(picker.selectedIndex).toBe(0);
    });

    test('no movement when list is empty', () => {
      picker.models = [];
      picker.selectedIndex = 0;
      picker.moveUp();
      picker.moveDown();
      expect(picker.selectedIndex).toBe(0);
    });

    test('stays at 0 with single item for both moveDown and moveUp', () => {
      picker.models = [FREE_MODEL];
      picker.selectedIndex = 0;
      picker.moveDown();
      expect(picker.selectedIndex).toBe(0);
      picker.moveUp();
      expect(picker.selectedIndex).toBe(0);
    });
  });

  // ── getSelected ───────────────────────────────────────────────────────────

  describe('getSelected()', () => {
    test('returns null when not in model mode', () => {
      picker.mode = 'effort';
      picker.models = ALL_MODELS;
      expect(picker.getSelected()).toBeNull();
    });

    test('returns null when filtered list is empty', () => {
      picker.models = ALL_MODELS;
      picker.query = 'zzz-no-match';
      expect(picker.getSelected()).toBeNull();
    });

    test('returns null when models array is empty', () => {
      picker.models = [];
      expect(picker.getSelected()).toBeNull();
    });

    test('returns correct model at selectedIndex', () => {
      picker.models = [FREE_MODEL, PREMIUM_MODEL];
      picker.selectedIndex = 1;
      expect(picker.getSelected()?.id).toBe('premium-1');
    });

    test('returns null for out-of-range selectedIndex', () => {
      picker.models = [FREE_MODEL];
      picker.selectedIndex = 99;
      // getSelected uses filtered[selectedIndex] ?? null
      expect(picker.getSelected()).toBeNull();
    });

    test('returns first model when selectedIndex is 0', () => {
      picker.models = ALL_MODELS;
      picker.selectedIndex = 0;
      expect(picker.getSelected()?.id).toBe('free-1');
    });
  });

  // ── openAllModels ─────────────────────────────────────────────────────────

  describe('openAllModels()', () => {
    test('activates the picker and sets mode to model', () => {
      picker.openAllModels(ALL_MODELS, 'free-1');
      expect(picker.active).toBe(true);
      expect(picker.mode).toBe('model');
    });

    test('pre-selects the current model by id', () => {
      picker.openAllModels(ALL_MODELS, 'premium-1');
      // premium-1 is index 2 in ALL_MODELS
      expect(picker.selectedIndex).toBe(2);
    });

    test('falls back to index 0 when currentModelId not found', () => {
      picker.openAllModels(ALL_MODELS, 'nonexistent');
      expect(picker.selectedIndex).toBe(0);
    });

    test('clears query and filter on open', () => {
      picker.query = 'old';
      picker.categoryFilter = 'free' as CategoryFilter;
      picker.openAllModels(ALL_MODELS, 'free-1');
      expect(picker.query).toBe('');
      expect(picker.categoryFilter).toBe('all');
    });

    test('pre-selects first model when list has one item', () => {
      picker.openAllModels([FREE_MODEL], 'free-1');
      expect(picker.selectedIndex).toBe(0);
    });

    test('starts with list focus instead of search focus', () => {
      picker.openAllModels(ALL_MODELS, 'free-1');
      expect(picker.searchFocused).toBe(false);
    });
  });

  // ── showModelsForProvider ───────────────────────────────────────────────────

  describe('showModelsForProvider()', () => {
    test('sets availableOnly to false so synthetic models are not filtered', () => {
      picker.availableOnly = true;
      picker.showModelsForProvider(ALL_MODELS, 'provA');
      expect(picker.availableOnly).toBe(false);
    });

    test('sets mode to model and resets query/filters', () => {
      picker.mode = 'provider' as PickerMode;
      picker.query = 'old';
      picker.categoryFilter = 'free' as CategoryFilter;
      picker.showModelsForProvider(ALL_MODELS, 'provA');
      expect(picker.mode).toBe('model');
      expect(picker.query).toBe('');
      expect(picker.categoryFilter).toBe('all');
    });

    test('returns to list focus when switching from provider list to model list', () => {
      picker.searchFocused = true;
      picker.showModelsForProvider(ALL_MODELS, 'provA');
      expect(picker.searchFocused).toBe(false);
    });
  });

  // ── Mode transitions ──────────────────────────────────────────────────────

  describe('mode transitions', () => {
    test('model → effort transition via showEffortPicker', () => {
      picker.openAllModels(ALL_MODELS, 'reasoning-1');
      picker.showEffortPicker(REASONING_MODEL, 'medium');
      expect(picker.mode).toBe('effort');
      expect(picker.pendingModel?.id).toBe('reasoning-1');
      expect(picker.effortLevels).toEqual(['low', 'medium', 'high']);
      // Pre-selects current effort
      expect(picker.selectedIndex).toBe(1); // 'medium' is index 1
    });

    test('showEffortPicker falls back to index 0 when current effort not found', () => {
      picker.showEffortPicker(REASONING_MODEL, 'nonexistent');
      expect(picker.selectedIndex).toBe(0);
    });

    test('close() resets all state and deactivates', () => {
      picker.openAllModels(ALL_MODELS, 'free-1');
      picker.showEffortPicker(REASONING_MODEL, 'low');
      picker.close();
      expect(picker.active).toBe(false);
      expect(picker.mode).toBe('model');
      expect(picker.models).toHaveLength(0);
      expect(picker.pendingModel).toBeNull();
      expect(picker.selectedIndex).toBe(0);
      expect(picker.query).toBe('');
      expect(picker.categoryFilter).toBe('all');
    });

    test('openAllModels() activates the picker and selects the current model', () => {
      picker.openAllModels(ALL_MODELS, 'free-2');
      expect(picker.active).toBe(true);
      expect(picker.selectedIndex).toBe(1);
    });
  });

  // ── Search helpers ────────────────────────────────────────────────────────

  describe('search helpers', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
    });

    test('appendChar adds to query and clamps selection', () => {
      picker.selectedIndex = 3;
      picker.appendChar('f');
      picker.appendChar('r');
      expect(picker.query).toBe('fr');
      // After filter, only 2 free models remain, so index should be clamped
      expect(picker.selectedIndex).toBeLessThanOrEqual(picker.getItemCount() - 1);
    });

    test('deleteChar removes last char', () => {
      picker.query = 'test';
      picker.deleteChar();
      expect(picker.query).toBe('tes');
    });

    test('deleteChar on empty query is a no-op', () => {
      picker.query = '';
      picker.deleteChar();
      expect(picker.query).toBe('');
    });

    test('clearQuery empties query', () => {
      picker.query = 'hello';
      picker.clearQuery();
      expect(picker.query).toBe('');
    });

    test('can focus and blur search in searchable modes', () => {
      picker.openAllModels(ALL_MODELS, 'free-1');
      picker.focusSearch();
      expect(picker.searchFocused).toBe(true);
      picker.blurSearch();
      expect(picker.searchFocused).toBe(false);
    });

    test('setCategoryFilter updates filter and clamps', () => {
      picker.selectedIndex = 3;
      picker.setCategoryFilter('free');
      expect(picker.categoryFilter).toBe('free');
      // Only 2 free models, so clamp to max index 1
      expect(picker.selectedIndex).toBeLessThanOrEqual(1);
    });
  });

  // ── Stage 5: Pricing tier filter ─────────────────────────────────────────

  describe('pricing tier filter (Stage 5)', () => {
    const SUB_MODEL = makeModel({ id: 'sub-1', displayName: 'Sub Model', tier: 'standard', provider: 'github' });
    const EXTENDED_MODELS = [...ALL_MODELS, SUB_MODEL];

    beforeEach(() => {
      picker.models = EXTENDED_MODELS;
    });

    test('cycleCategory cycles through all → free → paid → subscription → all', () => {
      expect(picker.categoryFilter).toBe('all');
      picker.cycleCategory();
      expect(picker.categoryFilter).toBe('free');
      picker.cycleCategory();
      expect(picker.categoryFilter).toBe('paid');
      picker.cycleCategory();
      expect(picker.categoryFilter).toBe('subscription');
      picker.cycleCategory();
      expect(picker.categoryFilter).toBe('all');
    });

    test('paid filter includes standard tier models', () => {
      picker.categoryFilter = 'paid';
      // SUB_MODEL has tier 'standard' which maps to 'paid'
      const result = picker.getFilteredModels();
      expect(result.some(m => m.id === 'sub-1')).toBe(true);
      expect(result.some(m => m.id === 'premium-1')).toBe(true);
    });

    test('free filter excludes paid models', () => {
      picker.categoryFilter = 'free';
      const result = picker.getFilteredModels();
      expect(result.every(m => m.tier === 'free')).toBe(true);
    });
  });

  // ── Stage 5: Capability filter ────────────────────────────────────────────

  describe('capability filter (Stage 5)', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
    });

    test('reasoning filter returns only reasoning models', () => {
      picker.setCapabilityFilter('reasoning');
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('reasoning-1');
    });

    test('toolUse filter returns models with toolCalling', () => {
      picker.setCapabilityFilter('toolUse');
      const result = picker.getFilteredModels();
      // All test models have toolCalling: true
      expect(result).toHaveLength(4);
    });

    test('multimodal filter returns only multimodal models', () => {
      picker.setCapabilityFilter('multimodal');
      const result = picker.getFilteredModels();
      // No multimodal models in ALL_MODELS
      expect(result).toHaveLength(0);
    });

    test('none capability filter returns all', () => {
      picker.setCapabilityFilter('none');
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(4);
    });

    test('capability filter combines with category filter', () => {
      picker.categoryFilter = 'paid';
      picker.setCapabilityFilter('reasoning');
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('reasoning-1');
    });
  });

  // ── Stage 5: Available-only filter ───────────────────────────────────────

  describe('available-only filter (Stage 5)', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
    });

    test('availableOnly defaults to true', () => {
      expect(picker.availableOnly).toBe(true);
    });

    test('availableOnly with empty configuredProviders shows all models', () => {
      picker.configuredProviders = new Set();
      // Empty set = filter is skipped
      expect(picker.getFilteredModels()).toHaveLength(4);
    });

    test('availableOnly with configured providers filters correctly', () => {
      picker.configuredProviders = new Set(['provA']);
      const result = picker.getFilteredModels();
      expect(result.every(m => m.provider === 'provA')).toBe(true);
    });

    test('toggleAvailableOnly disables the filter', () => {
      picker.configuredProviders = new Set(['provA']);
      picker.toggleAvailableOnly();
      expect(picker.availableOnly).toBe(false);
      // All models shown when filter is off
      expect(picker.getFilteredModels()).toHaveLength(4);
    });
  });

  // ── Stage 5: Benchmark sort ───────────────────────────────────────────────

  describe('benchmark sort (Stage 5)', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
      writeBenchmarksCache([
        { modelId: 'free-1', name: 'free-1', organization: 'test', benchmarks: { swe: 0.8, gpqa: 0.7 } },
        { modelId: 'premium-1', name: 'premium-1', organization: 'test', benchmarks: { swe: 0.9, gpqa: 0.85 } },
        { modelId: 'reasoning-1', name: 'reasoning-1', organization: 'test', benchmarks: { swe: 0.95, gpqa: 0.9 } },
      ], harness.benchmarkStore);
      harness.benchmarkStore.initBenchmarks();
    });

    afterEach(() => {
      writeBenchmarksCache([], harness.benchmarkStore);
      harness.benchmarkStore.initBenchmarks();
    });

    test('cycleBenchmarkSort cycles none → composite → swe → gpqa → none', () => {
      expect(picker.benchmarkSort).toBe('none');
      picker.cycleBenchmarkSort();
      expect(picker.benchmarkSort).toBe('composite');
      picker.cycleBenchmarkSort();
      expect(picker.benchmarkSort).toBe('swe');
      picker.cycleBenchmarkSort();
      expect(picker.benchmarkSort).toBe('gpqa');
      picker.cycleBenchmarkSort();
      expect(picker.benchmarkSort).toBe('none');
    });

    test('swe sort orders models by SWE score descending', () => {
      picker.benchmarkSort = 'swe';
      const result = picker.getFilteredModels();
      // reasoning-1 (0.95) > premium-1 (0.9) > free-1 (0.8) > free-2 (no score)
      expect(result[0].id).toBe('reasoning-1');
      expect(result[1].id).toBe('premium-1');
      expect(result[2].id).toBe('free-1');
      // free-2 has no score, sinks to end
      expect(result[result.length - 1].id).toBe('free-2');
    });

    test('gpqa sort orders models by GPQA score descending', () => {
      picker.benchmarkSort = 'gpqa';
      const result = picker.getFilteredModels();
      expect(result[0].id).toBe('reasoning-1'); // gpqa: 0.9
      expect(result[1].id).toBe('premium-1');   // gpqa: 0.85
    });

    test('models without benchmark scores sink to end of sort', () => {
      picker.benchmarkSort = 'composite';
      const result = picker.getFilteredModels();
      // free-2 has no benchmark data, must be last
      expect(result[result.length - 1].id).toBe('free-2');
    });
  });

  // ── Stage 5: Family grouping ──────────────────────────────────────────────

  describe('family grouping (Stage 5)', () => {
    test('detectFamily identifies Claude family', () => {
      const m = makeModel({ id: 'claude-3-sonnet', displayName: 'Claude 3 Sonnet' });
      expect(detectFamily(m)).toBe('Claude');
    });

    test('detectFamily identifies GPT family', () => {
      const m = makeModel({ id: 'gpt-4o', displayName: 'GPT-4o' });
      expect(detectFamily(m)).toBe('GPT');
    });

    test('detectFamily identifies Gemini family', () => {
      const m = makeModel({ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' });
      expect(detectFamily(m)).toBe('Gemini');
    });

    test('detectFamily identifies DeepSeek family', () => {
      const m = makeModel({ id: 'deepseek-v3', displayName: 'DeepSeek V3' });
      expect(detectFamily(m)).toBe('DeepSeek');
    });

    test('detectFamily returns Other for unknown model', () => {
      const m = makeModel({ id: 'some-random-model', displayName: 'Random Model' });
      expect(detectFamily(m)).toBe('Other');
    });

    test('family grouping produces correct group headers in getItems()', () => {
      const claudeM = makeModel({ id: 'claude-opus', displayName: 'Claude Opus', provider: 'anthropic' });
      const gptM = makeModel({ id: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai' });
      const deepseekM = makeModel({ id: 'deepseek-v3', displayName: 'DeepSeek V3', provider: 'deepseek' });
      picker.models = [claudeM, gptM, deepseekM];
      picker.groupBy = 'family';
      const items = picker.getItems();
      const headers = items.filter(i => i.isGroupHeader).map(i => i.label);
      expect(headers).toContain('Claude');
      expect(headers).toContain('GPT');
      expect(headers).toContain('DeepSeek');
    });
  });

  // ── Stage 5: Group-by cycling ─────────────────────────────────────────────

  describe('group-by cycling (Stage 5)', () => {
    test('cycleGroupBy cycles provider → family → pricingTier → qualityTier → provider', () => {
      expect(picker.groupBy).toBe('provider');
      picker.cycleGroupBy();
      expect(picker.groupBy).toBe('family');
      picker.cycleGroupBy();
      expect(picker.groupBy).toBe('pricingTier');
      picker.cycleGroupBy();
      expect(picker.groupBy).toBe('qualityTier');
      picker.cycleGroupBy();
      expect(picker.groupBy).toBe('provider');
    });
  });

  // ── Stage 5: tierToCategoryFilter ────────────────────────────────────────

  describe('tierToCategoryFilter (Stage 5)', () => {
    test('free tier maps to free', () => expect(tierToCategoryFilter('free')).toBe('free'));
    test('premium tier maps to paid', () => expect(tierToCategoryFilter('premium')).toBe('paid'));
    test('standard tier maps to paid', () => expect(tierToCategoryFilter('standard')).toBe('paid'));
    test('subscription tier maps to subscription', () => expect(tierToCategoryFilter('subscription')).toBe('subscription'));
    test('undefined tier maps to paid', () => expect(tierToCategoryFilter(undefined)).toBe('paid'));
  });

  // ── Stage 5: Pinned models ────────────────────────────────────────────────

  describe('pinned models (Stage 5)', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS;
    });

    test('pinned models appear before unpinned in getItems()', () => {
      picker.pinnedIds = new Set(['reasoning-1']);
      const items = picker.getItems();
      // First non-header item (after Favorites header) should be reasoning-1
      const firstHeader = items.find(i => i.isGroupHeader && i.label === 'Favorites');
      expect(firstHeader).toBeDefined();
      const firstModelItem = items[items.indexOf(firstHeader!) + 1];
      expect(firstModelItem?.id).toBe('reasoning-1');
      expect(firstModelItem?.isPinned).toBe(true);
    });

    test('Favorites header appears when pinnedIds is non-empty and models match', () => {
      picker.pinnedIds = new Set(['free-1']);
      const items = picker.getItems();
      expect(items.some(i => i.isGroupHeader && i.label === 'Favorites')).toBe(true);
    });

    test('no Favorites header when pinnedIds is empty', () => {
      picker.pinnedIds = new Set();
      const items = picker.getItems();
      expect(items.some(i => i.isGroupHeader && i.label === 'Favorites')).toBe(false);
    });

    test('pinned model not in filtered list does not show Favorites header', () => {
      picker.pinnedIds = new Set(['not-in-list']);
      const items = picker.getItems();
      expect(items.some(i => i.isGroupHeader && i.label === 'Favorites')).toBe(false);
    });
  });

  // ── getFilteredProviders ──────────────────────────────────────────────────

  describe('getFilteredProviders()', () => {
    beforeEach(() => {
      picker.mode = 'provider';
      picker.providers = ['anthropic', 'openai', 'gemini', 'mistral'];
    });

    test('returns all providers when query is empty', () => {
      expect(picker.getFilteredProviders()).toHaveLength(4);
    });

    test('filters by substring match', () => {
      picker.query = 'ai';
      const result = picker.getFilteredProviders();
      // 'openai' and 'mistral' don't match, but 'openai' contains 'ai'
      expect(result).toContain('openai');
      expect(result).not.toContain('anthropic');
      expect(result).not.toContain('gemini');
      expect(result).not.toContain('mistral');
    });

    test('filter is case-insensitive', () => {
      picker.query = 'GEMINI';
      expect(picker.getFilteredProviders()).toEqual(['gemini']);
    });

    test('empty whitespace query returns all', () => {
      picker.query = '   ';
      expect(picker.getFilteredProviders()).toHaveLength(4);
    });

    test('no match returns empty array', () => {
      picker.query = 'zzz-no-match';
      expect(picker.getFilteredProviders()).toHaveLength(0);
    });

    test('getItemCount uses filtered providers in provider mode', () => {
      picker.query = 'open';
      expect(picker.getItemCount()).toBe(1);
    });

    test('appendChar clamps selectedIndex against filtered providers', () => {
      picker.selectedIndex = 3;
      picker.appendChar('g');
      // Only 'gemini' matches — index must be 0
      expect(picker.selectedIndex).toBe(0);
    });

    test('clearing query restores full provider list', () => {
      picker.query = 'open';
      picker.clearQuery();
      expect(picker.getFilteredProviders()).toHaveLength(4);
    });
  });

  // ── scrollOffset behavior ────────────────────────────────────────────────────

  describe('scrollOffset behavior', () => {
    beforeEach(() => {
      picker.models = ALL_MODELS; // 4 selectable items
    });

    test('moveDown past maxVisible increments scrollOffset', () => {
      // maxVisible = 2, so scrollOffset should advance once selectedIndex > 1
      const maxVis = 2;
      picker.selectedIndex = 0;
      picker.scrollOffset = 0;
      picker.moveDown(maxVis); // → 1, still in window [0,2)
      expect(picker.scrollOffset).toBe(0);
      picker.moveDown(maxVis); // → 2, now >= scrollOffset + maxVis → scroll
      expect(picker.scrollOffset).toBe(1);
      picker.moveDown(maxVis); // → 3, now >= 1 + 2 → scroll
      expect(picker.scrollOffset).toBe(2);
    });

    test('moveDown wrap-to-0 resets scrollOffset to 0', () => {
      const maxVis = 2;
      picker.selectedIndex = 3; // last item
      picker.scrollOffset = 2;
      picker.moveDown(maxVis); // wraps to 0 → scrollOffset should be 0
      expect(picker.selectedIndex).toBe(0);
      expect(picker.scrollOffset).toBe(0);
    });

    test('_scrollToSelection keeps selection in visible range when scrolling down', () => {
      picker.selectedIndex = 3;
      picker.scrollOffset = 0;
      picker._scrollToSelection(2); // window [0,2) does not contain 3 → adjust
      expect(picker.scrollOffset).toBe(2); // 3 - 2 + 1 = 2
      expect(picker.selectedIndex).toBeGreaterThanOrEqual(picker.scrollOffset);
      expect(picker.selectedIndex).toBeLessThan(picker.scrollOffset + 2);
    });

    test('_clampSelection resets scrollOffset when item count shrinks below offset', () => {
      // Put scrollOffset beyond new list boundary
      picker.selectedIndex = 3;
      picker.scrollOffset = 3;
      // Shrink list to 1 item via filter
      picker.query = 'Free Model 1';
      picker['_clampSelection']();
      expect(picker.scrollOffset).toBe(0);
      expect(picker.selectedIndex).toBe(0);
    });
  });

  // ── Provider grouping ────────────────────────────────────────────────────────

  describe('provider grouping', () => {
    beforeEach(() => {
      picker.mode = 'provider';
      // Mix of configured, popular, and unknown providers
      picker.providers = ['anthropic', 'openai', 'groq', 'someCustomProvider', 'anotherUnknown', 'google'];
      picker.configuredProviders = new Set(['anthropic', 'openai']);
    });

    test('POPULAR_PROVIDERS contains the 8 expected providers', () => {
      expect(POPULAR_PROVIDERS.has('anthropic')).toBe(true);
      expect(POPULAR_PROVIDERS.has('google')).toBe(true);
      expect(POPULAR_PROVIDERS.has('groq')).toBe(true);
      expect(POPULAR_PROVIDERS.has('mistral')).toBe(true);
      expect(POPULAR_PROVIDERS.has('nvidia')).toBe(true);
      expect(POPULAR_PROVIDERS.has('ollama')).toBe(true);
      expect(POPULAR_PROVIDERS.has('openai')).toBe(true);
      expect(POPULAR_PROVIDERS.has('openrouter')).toBe(true);
      expect(POPULAR_PROVIDERS.has('synthetic')).toBe(true);
      expect(POPULAR_PROVIDERS.size).toBe(9);
    });

    test('getGroupedProviders splits into popular / all (no configured group)', () => {
      const { popular, all } = picker.getGroupedProviders();
      // anthropic and openai are in POPULAR_PROVIDERS so they go to popular regardless of config
      expect(popular).toContain('anthropic');
      expect(popular).toContain('openai');
      // groq and google are also popular
      expect(popular).toContain('groq');
      expect(popular).toContain('google');
      // custom providers go to all
      expect(all).toContain('someCustomProvider');
      expect(all).toContain('anotherUnknown');
    });

    test('configured popular providers appear in popular group', () => {
      const { popular } = picker.getGroupedProviders();
      // anthropic and openai are in POPULAR_PROVIDERS, so they appear in popular
      // regardless of whether they are configured
      expect(popular).toContain('anthropic');
      expect(popular).toContain('openai');
    });

    test('popular providers are excluded from all group', () => {
      const { all } = picker.getGroupedProviders();
      // anthropic and openai are in POPULAR_PROVIDERS, so they go to popular not all
      expect(all).not.toContain('anthropic');
      expect(all).not.toContain('openai');
    });

    test('each group is alphabetized', () => {
      picker.providers = ['openai', 'anthropic', 'groq', 'google', 'zzz', 'aaa'];
      picker.configuredProviders = new Set(['openai', 'anthropic']);
      const { popular, all } = picker.getGroupedProviders();
      // all POPULAR_PROVIDERS members go to popular, alphabetized
      expect(popular).toEqual(['anthropic', 'google', 'groq', 'openai']);
      expect(all).toEqual(['aaa', 'zzz']);
    });

    test('getFilteredProviders returns popular first, then all', () => {
      const result = picker.getFilteredProviders();
      const anthIdx = result.indexOf('anthropic');
      const openaiIdx = result.indexOf('openai');
      const groqIdx = result.indexOf('groq');
      const customIdx = result.indexOf('someCustomProvider');
      // All popular providers come before unknown (all) providers
      expect(anthIdx).toBeLessThan(customIdx);
      expect(openaiIdx).toBeLessThan(customIdx);
      expect(groqIdx).toBeLessThan(customIdx);
    });

    test('getItems in provider mode inserts group headers', () => {
      const items = picker.getItems();
      const headerLabels = items.filter(i => i.isGroupHeader).map(i => i.label);
      expect(headerLabels).not.toContain('Configured');
      expect(headerLabels).toContain('Popular');
      expect(headerLabels).toContain('All Providers');
    });

    test('getItems marks configured providers with isConfigured', () => {
      const items = picker.getItems();
      const configuredItems = items.filter(i => !i.isGroupHeader && i.isConfigured);
      const configuredIds = configuredItems.map(i => i.id);
      expect(configuredIds).toContain('anthropic');
      expect(configuredIds).toContain('openai');
    });

    test('non-configured items do not have isConfigured set', () => {
      const items = picker.getItems();
      const groqItem = items.find(i => i.id === 'groq');
      expect(groqItem?.isConfigured).toBeFalsy();
    });

    test('Configured group header never appears (removed)', () => {
      picker.configuredProviders = new Set();
      const items = picker.getItems();
      const headerLabels = items.filter(i => i.isGroupHeader).map(i => i.label);
      expect(headerLabels).not.toContain('Configured');
      // Popular header should still appear for popular providers
      expect(headerLabels).toContain('Popular');
    });

    test('empty Popular group hides the header', () => {
      picker.providers = ['someCustomProvider', 'anotherUnknown'];
      picker.configuredProviders = new Set();
      const items = picker.getItems();
      const headerLabels = items.filter(i => i.isGroupHeader).map(i => i.label);
      expect(headerLabels).not.toContain('Popular');
      expect(headerLabels).not.toContain('Configured');
      expect(headerLabels).toContain('All Providers');
    });

    test('empty All group hides the header', () => {
      picker.providers = ['anthropic', 'openai', 'groq'];
      picker.configuredProviders = new Set(['anthropic', 'openai']);
      const items = picker.getItems();
      const headerLabels = items.filter(i => i.isGroupHeader).map(i => i.label);
      expect(headerLabels).not.toContain('All Providers');
    });

    test('getItems count (headers + selectables) in provider mode', () => {
      // 4 popular (anthropic, google, groq, openai) + 2 all = 6 selectables + 2 headers = 8
      const items = picker.getItems();
      const headers = items.filter(i => i.isGroupHeader);
      const selectables = items.filter(i => !i.isGroupHeader);
      expect(headers).toHaveLength(2);
      expect(selectables).toHaveLength(6);
    });

    test('search filter preserves group structure', () => {
      picker.query = 'o'; // matches openai, google, someCustomProvider, anotherUnknown
      const items = picker.getItems();
      const headers = items.filter(i => i.isGroupHeader).map(i => i.label);
      // openai and google are popular, custom providers are in all
      expect(headers).not.toContain('Configured');
      expect(headers).toContain('Popular');
      expect(headers).toContain('All Providers');
    });

    test('search filter hides empty groups when no matches', () => {
      picker.query = 'custom'; // only matches someCustomProvider
      const items = picker.getItems();
      const headers = items.filter(i => i.isGroupHeader).map(i => i.label);
      // Only All Providers group has a match
      expect(headers).not.toContain('Configured');
      expect(headers).not.toContain('Popular');
      expect(headers).toContain('All Providers');
    });

    test('getFilteredProviders count matches getItemCount in provider mode', () => {
      expect(picker.getItemCount()).toBe(picker.getFilteredProviders().length);
    });

    test('case-insensitive match for popular providers', () => {
      // Provider IDs may come in mixed case from registry
      picker.providers = ['Anthropic', 'OpenAI', 'Groq'];
      picker.configuredProviders = new Set(['Anthropic']);
      const { popular } = picker.getGroupedProviders();
      // All three are in POPULAR_PROVIDERS (case-insensitive)
      expect(popular).toContain('Anthropic');
      expect(popular).toContain('OpenAI');
      expect(popular).toContain('Groq');
    });
  });
});
