/**
 * Tests for ModelPickerModal state class.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { ModelPickerModal } from '../../input/model-picker.ts';
import type { ModelDefinition } from '../../providers/registry.ts';

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

    test('filters by premium tier', () => {
      picker.categoryFilter = 'premium';
      const result = picker.getFilteredModels();
      expect(result).toHaveLength(2);
      expect(result.every(m => m.tier === 'premium')).toBe(true);
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
      picker.categoryFilter = 'premium';
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

    test('moveUp wraps from 0 to last', () => {
      picker.selectedIndex = 0;
      picker.moveUp();
      expect(picker.selectedIndex).toBe(2);
    });

    test('no movement when list is empty', () => {
      picker.models = [];
      picker.selectedIndex = 0;
      picker.moveUp();
      picker.moveDown();
      expect(picker.selectedIndex).toBe(0);
    });

    test('wraps correctly with single item', () => {
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
      expect(picker.categoryFilter).toBe('all');
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
});
