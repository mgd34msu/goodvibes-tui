/**
 * Tests for ModelPickerModal state class.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { ModelPickerModal, detectFamily, tierToCategoryFilter } from '../../input/model-picker.ts';
import type { ModelDefinition } from '../../providers/registry.ts';
import { _setEntriesForTest } from '../../providers/model-benchmarks.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    provider: 'test-provider',
    displayName: 'Test Model',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'free',
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ModelPickerModal', () => {
  let picker: ModelPickerModal;

  beforeEach(() => {
    picker = new ModelPickerModal();
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

    test('provider mode returns flat list', () => {
      picker.mode = 'provider';
      picker.providers = ['provA', 'provB'];
      const items = picker.getItems();
      expect(items).toHaveLength(2);
      expect(items[0].isGroupHeader).toBeFalsy();
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
      picker.categoryFilter = 'free';
      picker.openAllModels(ALL_MODELS, 'free-1');
      expect(picker.query).toBe('');
      expect(picker.categoryFilter as string).toBe('all');
    });

    test('pre-selects first model when list has one item', () => {
      picker.openAllModels([FREE_MODEL], 'free-1');
      expect(picker.selectedIndex).toBe(0);
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

    test('open() is an alias for openAllModels', () => {
      picker.open(ALL_MODELS, 'free-2');
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
      // Inject benchmark data for sorting tests
      _setEntriesForTest([
        { modelId: 'free-1', name: 'free-1', organization: 'test', benchmarks: { swe: 0.8, gpqa: 0.7 } },
        { modelId: 'premium-1', name: 'premium-1', organization: 'test', benchmarks: { swe: 0.9, gpqa: 0.85 } },
        { modelId: 'reasoning-1', name: 'reasoning-1', organization: 'test', benchmarks: { swe: 0.95, gpqa: 0.9 } },
      ]);
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
});
