import type { ModelDefinition } from '../providers/registry.ts';
import { EFFORT_DESCRIPTIONS } from '../providers/effort-levels.ts';
import { getBenchmarks, getQualityTier, compositeScore, A_TIER_THRESHOLD } from '../providers/model-benchmarks.ts';
import { getSyntheticModelInfo } from '../providers/synthetic.ts';

export type PickerMode = 'model' | 'provider' | 'effort';

/**
 * Pricing tier filter.
 * 'paid' matches ModelDefinition tiers 'standard' and 'premium' for forward-compat
 * with future CatalogModel tiers ('free' | 'paid' | 'subscription').
 */
export type CategoryFilter = 'all' | 'free' | 'paid' | 'subscription';

/** Model family grouping names. */
export type ModelFamily =
  | 'GPT'
  | 'Claude'
  | 'Gemini'
  | 'Llama'
  | 'Qwen'
  | 'GLM'
  | 'MiniMax'
  | 'DeepSeek'
  | 'Mistral'
  | 'Command'
  | 'Grok'
  | 'Kimi'
  | 'Other';

/** Capability filter — subset of ModelDefinition capabilities. */
export type CapabilityFilter = 'reasoning' | 'toolUse' | 'multimodal' | 'none';

/** Benchmark score sort order. */
export type BenchmarkSort = 'none' | 'composite' | 'swe' | 'gpqa';

/** Group-by cycling order. */
export type GroupByMode = 'provider' | 'family' | 'pricingTier' | 'qualityTier';

// ── Family detection helpers ──────────────────────────────────────────────────

/** Patterns for detecting model family from id/displayName. */
const FAMILY_PATTERNS: Array<{ pattern: RegExp; family: ModelFamily }> = [
  { pattern: /claude/i,          family: 'Claude' },
  { pattern: /gpt|\bo1\b|\bo3\b|\bo4\b/i, family: 'GPT' },
  { pattern: /gemini/i,          family: 'Gemini' },
  { pattern: /llama/i,           family: 'Llama' },
  { pattern: /qwen/i,            family: 'Qwen' },
  { pattern: /glm|chatglm/i,     family: 'GLM' },
  { pattern: /minimax|abab/i,    family: 'MiniMax' },
  { pattern: /deepseek/i,        family: 'DeepSeek' },
  { pattern: /mistral|mixtral/i, family: 'Mistral' },
  { pattern: /command|cohere/i,  family: 'Command' },
  { pattern: /grok/i,            family: 'Grok' },
  { pattern: /kimi|moonshot/i,   family: 'Kimi' },
];

/** Detect the model family from id and displayName. */
export function detectFamily(model: ModelDefinition): ModelFamily {
  const haystack = `${model.id} ${model.displayName}`;
  for (const { pattern, family } of FAMILY_PATTERNS) {
    if (pattern.test(haystack)) return family;
  }
  return 'Other';
}

/**
 * Map ModelDefinition tier to CategoryFilter bucket.
 * 'standard' and 'premium' both map to 'paid' for forward-compat.
 */
export function tierToCategoryFilter(tier: string | undefined): CategoryFilter {
  if (tier === 'free') return 'free';
  if (tier === 'subscription') return 'subscription';
  return 'paid';
}

/** A generic selectable item for non-model modes. */
export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  /** If true, this item is a group header (not selectable). */
  isGroupHeader?: boolean;
  /** Quality tier badge for model items: S/A/B/C. */
  qualityTier?: string;
  /** Whether this model is pinned/favorited. */
  isPinned?: boolean;
  /** True when model tier is free. */
  isFree?: boolean;
  /** True when this provider item has a configured API key. */
  isConfigured?: boolean;
}

/** Provider IDs treated as "Popular" in the provider picker. */
export const POPULAR_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'google',
  'groq',
  'mistral',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
]);

/**
 * ModelPickerModal - Multi-step interactive picker for model, provider, and effort.
 * Supports three modes: 'model', 'provider', 'effort'.
 *
 * Stage 5 features:
 * - Pricing tier filter: Free / Paid / Subscription / All
 * - Family grouping: GPT, Claude, Gemini, Llama, Qwen, etc.
 * - Capability filters: reasoning, toolUse, multimodal
 * - Available-only toggle (filters to configured providers)
 * - Benchmark sort: composite / SWE / GPQA
 * - Group-by cycling: provider → family → pricingTier → qualityTier
 * - Quality tier badge (S/A/B/C) from model-benchmarks
 * - Pinned/favorite indicator
 */
export class ModelPickerModal {
  public active = false;
  public mode: PickerMode = 'model';
  public selectedIndex = 0;
  /** Scroll offset for the visible item window (tracks first visible item index). */
  public scrollOffset = 0;
  public models: ModelDefinition[] = [];
  public providers: string[] = [];
  public effortLevels: string[] = [];
  /** The model chosen in model-mode, awaiting effort selection. */
  public pendingModel: ModelDefinition | null = null;

  // ── Search / filter ──────────────────────────────────────────────────────────
  /** Current search query string (empty = no filter). */
  public query = '';
  /** Active pricing tier filter. */
  public categoryFilter: CategoryFilter = 'all';
  /** Active capability filter. */
  public capabilityFilter: CapabilityFilter = 'none';
  /** When true, only show models from providers with a configured API key. */
  public availableOnly = true;
  /** Set of provider names that have a configured key (used for availableOnly filter). */
  public configuredProviders: Set<string> = new Set();
  /** IDs of pinned/favorite models — shown at top of list. */
  public pinnedIds: Set<string> = new Set();
  /** Benchmark score sort order. */
  public benchmarkSort: BenchmarkSort = 'none';
  /** Current group-by mode. */
  public groupBy: GroupByMode = 'provider';

  // ── Category filter cycling ───────────────────────────────────────────────
  private static readonly CATEGORY_CYCLE: CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
  /** Cycle to next pricing tier filter. */
  cycleCategory(): void {
    const idx = ModelPickerModal.CATEGORY_CYCLE.indexOf(this.categoryFilter);
    this.categoryFilter = ModelPickerModal.CATEGORY_CYCLE[(idx + 1) % ModelPickerModal.CATEGORY_CYCLE.length];
    this._clampSelection();
  }

  // ── Group-by cycling ──────────────────────────────────────────────────────
  private static readonly GROUP_BY_CYCLE: GroupByMode[] = ['provider', 'family', 'pricingTier', 'qualityTier'];
  /** Cycle to next group-by mode. */
  cycleGroupBy(): void {
    const idx = ModelPickerModal.GROUP_BY_CYCLE.indexOf(this.groupBy);
    this.groupBy = ModelPickerModal.GROUP_BY_CYCLE[(idx + 1) % ModelPickerModal.GROUP_BY_CYCLE.length];
    this._clampSelection();
  }

  // ── Benchmark sort cycling ────────────────────────────────────────────────
  private static readonly BENCHMARK_SORT_CYCLE: BenchmarkSort[] = ['none', 'composite', 'swe', 'gpqa'];
  /** Cycle to next benchmark sort order. */
  cycleBenchmarkSort(): void {
    const idx = ModelPickerModal.BENCHMARK_SORT_CYCLE.indexOf(this.benchmarkSort);
    this.benchmarkSort = ModelPickerModal.BENCHMARK_SORT_CYCLE[(idx + 1) % ModelPickerModal.BENCHMARK_SORT_CYCLE.length];
    this._clampSelection();
  }

  /** Open showing all models — entry point for /model */
  openAllModels(models: ModelDefinition[], currentModelId: string): void {
    this.models = models;
    this.mode = 'model';
    this.active = true;
    this.pendingModel = null;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    const filtered = this.getFilteredModels();
    const idx = filtered.findIndex(m => m.id === currentModelId);
    this.selectedIndex = idx >= 0 ? idx : 0;
    this.scrollOffset = 0;
  }

  /** Open showing providers first — entry point for /provider */
  openProviders(providers: string[], currentProvider: string): void {
    this.providers = providers;
    this.mode = 'provider';
    this.active = true;
    this.pendingModel = null;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    const idx = providers.indexOf(currentProvider);
    this.selectedIndex = idx >= 0 ? idx : 0;
    this.scrollOffset = 0;
  }

  /** Transition to model list filtered by provider (called from provider mode Enter). */
  showModelsForProvider(models: ModelDefinition[], _provider: string): void {
    this.models = models;
    this.mode = 'model';
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  /** Transition to effort picker after model is chosen. */
  showEffortPicker(model: ModelDefinition, currentEffort: string): void {
    this.pendingModel = model;
    this.effortLevels = model.reasoningEffort ?? [];
    this.mode = 'effort';
    const idx = this.effortLevels.indexOf(currentEffort);
    this.selectedIndex = idx >= 0 ? idx : 0;
    this.scrollOffset = 0;
  }

  /** Backward-compat alias for openAllModels (used by existing wiring). */
  open(models: ModelDefinition[], currentModelId: string): void {
    this.openAllModels(models, currentModelId);
  }

  /** Close the picker entirely. */
  close(): void {
    this.active = false;
    this.mode = 'model';
    this.models = [];
    this.providers = [];
    this.pendingModel = null;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
  }

  // ── Search helpers ─────────────────────────────────────────────────────────

  /** Append a character to the search query and clamp selectedIndex. */
  appendChar(ch: string): void {
    this.query += ch;
    this._clampSelection();
  }

  /** Delete the last character from the search query and clamp selectedIndex. */
  deleteChar(): void {
    if (this.query.length > 0) {
      this.query = this.query.slice(0, -1);
      this._clampSelection();
    }
  }

  /** Clear the search query and clamp selectedIndex. */
  clearQuery(): void {
    this.query = '';
    this._clampSelection();
  }

  /** Set category filter and clamp selectedIndex. */
  setCategoryFilter(filter: CategoryFilter): void {
    this.categoryFilter = filter;
    this._clampSelection();
  }

  /** Set capability filter and clamp selectedIndex. */
  setCapabilityFilter(filter: CapabilityFilter): void {
    this.capabilityFilter = filter;
    this._clampSelection();
  }

  /** Toggle the available-only filter. */
  toggleAvailableOnly(): void {
    this.availableOnly = !this.availableOnly;
    this._clampSelection();
  }

  /**
   * Split providers into three ordered groups: Configured, Popular, All.
   * Each group is alphabetized. Configured takes priority — Popular and All
   * exclude providers already in Configured.
   */
  getGroupedProviders(): { configured: string[]; popular: string[]; all: string[] } {
    const configured: string[] = [];
    const popular: string[] = [];
    const all: string[] = [];

    for (const p of this.providers) {
      const pLower = p.toLowerCase();
      if (this.configuredProviders.has(p)) {
        configured.push(p);
      } else if (POPULAR_PROVIDERS.has(pLower)) {
        popular.push(p);
      } else {
        all.push(p);
      }
    }

    configured.sort((a, b) => a.localeCompare(b));
    popular.sort((a, b) => a.localeCompare(b));
    all.sort((a, b) => a.localeCompare(b));

    return { configured, popular, all };
  }

  /** Return providers matching the current query (case-insensitive substring), in grouped order. */
  getFilteredProviders(): string[] {
    const { configured, popular, all } = this.getGroupedProviders();
    const ordered = [...configured, ...popular, ...all];
    if (this.query.trim().length === 0) return ordered;
    const q = this.query.toLowerCase();
    return ordered.filter(p => p.toLowerCase().includes(q));
  }

  /** Return models matching all current filters, sorted per benchmarkSort. */
  getFilteredModels(): ModelDefinition[] {
    let result = this.models;

    // Available-only filter
    if (this.availableOnly && this.configuredProviders.size > 0) {
      result = result.filter(m => this.configuredProviders.has(m.provider));
    }

    // Pricing tier / category filter
    if (this.categoryFilter === 'free') {
      result = result.filter(m => m.tier === 'free');
    } else if (this.categoryFilter === 'paid') {
      result = result.filter(m => m.tier === 'standard' || m.tier === 'premium' || m.tier == null);
    } else if (this.categoryFilter === 'subscription') {
      result = result.filter(m => tierToCategoryFilter(m.tier) === 'subscription');
    }

    // Capability filter
    if (this.capabilityFilter === 'reasoning') {
      result = result.filter(m => m.capabilities?.reasoning === true);
    } else if (this.capabilityFilter === 'toolUse') {
      result = result.filter(m => m.capabilities?.toolCalling === true);
    } else if (this.capabilityFilter === 'multimodal') {
      result = result.filter(m => m.capabilities?.multimodal === true);
    }

    // Query filter — fuzzy: every space-separated word must appear somewhere
    if (this.query.trim().length > 0) {
      const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      result = result.filter(m => {
        const haystack = `${m.id} ${m.displayName} ${m.provider}`.toLowerCase();
        return words.every(w => haystack.includes(w));
      });
    }

    // Benchmark sort
    if (this.benchmarkSort !== 'none') {
      result = [...result].sort((a, b) => {
        const bA = getBenchmarks(a.id) ?? getBenchmarks(a.displayName);
        const bB = getBenchmarks(b.id) ?? getBenchmarks(b.displayName);
        let scoreA: number | null = null;
        let scoreB: number | null = null;
        if (this.benchmarkSort === 'composite') {
          scoreA = bA ? compositeScore(bA.benchmarks) : null;
          scoreB = bB ? compositeScore(bB.benchmarks) : null;
        } else if (this.benchmarkSort === 'swe') {
          scoreA = bA?.benchmarks.swe ?? null;
          scoreB = bB?.benchmarks.swe ?? null;
        } else if (this.benchmarkSort === 'gpqa') {
          scoreA = bA?.benchmarks.gpqa ?? null;
          scoreB = bB?.benchmarks.gpqa ?? null;
        }
        // Models with no score sink to the end
        if (scoreA == null && scoreB == null) return 0;
        if (scoreA == null) return 1;
        if (scoreB == null) return -1;
        return scoreB - scoreA; // descending
      });
    }

    // Synthetic sub-grouping: when groupBy is 'provider', order synthetic models so that
    // "Top Models" (score ≥ 0.65) appear before "All Synthetic", each sub-group internally
    // sorted: top by composite score desc, all alphabetically by id.
    if (this.groupBy === 'provider' && this.benchmarkSort === 'none') {
      const nonSynthetic = result.filter(m => m.provider !== 'synthetic');
      const synthetic = result.filter(m => m.provider === 'synthetic');

      if (synthetic.length > 0) {
        const topModels = synthetic.filter(m => this._getSyntheticSubgroup(m) === 'top');
        const allModels = synthetic.filter(m => this._getSyntheticSubgroup(m) === 'all');

        // Sort top models by composite score descending
        topModels.sort((a, b) => {
          const bA = getBenchmarks(a.id) ?? getBenchmarks(a.displayName);
          const bB = getBenchmarks(b.id) ?? getBenchmarks(b.displayName);
          const sA = bA ? compositeScore(bA.benchmarks) : null;
          const sB = bB ? compositeScore(bB.benchmarks) : null;
          if (sA == null && sB == null) return 0;
          if (sA == null) return 1;
          if (sB == null) return -1;
          return sB - sA;
        });

        // Sort remaining alphabetically by id
        allModels.sort((a, b) => a.id.localeCompare(b.id));

        result = [...nonSynthetic, ...topModels, ...allModels];
      }
    }

    return result;
  }

  /**
   * Return the group key for a model under the current groupBy mode.
   * Used for inserting group headers in getItems().
   *
   * For synthetic provider models with groupBy 'provider', returns sub-group keys:
   * - 'Top Models'   — benchmark composite score ≥ 0.65 (A-tier or S-tier)
   * - 'All Synthetic' — remaining synthetic models
   */
  getModelGroupKey(model: ModelDefinition): string {
    switch (this.groupBy) {
      case 'provider':
        if (model.provider === 'synthetic') {
          return this._getSyntheticSubgroup(model) === 'top' ? 'Top Models' : 'All Synthetic';
        }
        return model.provider;
      case 'family':      return detectFamily(model);
      case 'pricingTier': return tierToCategoryFilter(model.tier);
      case 'qualityTier': {
        const b = getBenchmarks(model.id) ?? getBenchmarks(model.displayName);
        return b ? getQualityTier(b.benchmarks) : 'C';
      }
    }
  }

  /**
   * Classify a synthetic model as 'top' or 'all' based on benchmark composite score.
   * 'top': has benchmark data and score ≥ 0.65 (A-tier or S-tier)
   * 'all': no benchmark data or score < 0.65
   */
  private _getSyntheticSubgroup(model: ModelDefinition): 'top' | 'all' {
    const b = getBenchmarks(model.id) ?? getBenchmarks(model.displayName);
    if (!b) return 'all';
    const score = compositeScore(b.benchmarks);
    return score !== null && score >= A_TIER_THRESHOLD ? 'top' : 'all';
  }

  /** Get the items for the current mode as a unified list. */
  getItems(): PickerItem[] {
    if (this.mode === 'model') {
      const filtered = this.getFilteredModels();

      // Separate pinned and unpinned
      const pinned = filtered.filter(m => this.pinnedIds.has(m.id));
      const unpinned = filtered.filter(m => !this.pinnedIds.has(m.id));

      const items: PickerItem[] = [];

      // Pinned section header (only if pinned models are in the filtered list)
      if (pinned.length > 0) {
        items.push({ id: '__header__pinned', label: 'Favorites', isGroupHeader: true });
        for (const m of pinned) {
          items.push(this._modelToItem(m, true));
        }
      }

      // Grouped unpinned models
      let lastGroupKey = '';
      for (const m of unpinned) {
        const groupKey = this.getModelGroupKey(m);
        if (groupKey !== lastGroupKey) {
          items.push({ id: `__header__${groupKey}`, label: groupKey, isGroupHeader: true });
          lastGroupKey = groupKey;
        }
        items.push(this._modelToItem(m, false));
      }

      return items;
    }
    if (this.mode === 'provider') {
      const q = this.query.trim().toLowerCase();
      const { configured, popular, all } = this.getGroupedProviders();

      const filterGroup = (group: string[]) =>
        q.length === 0 ? group : group.filter(p => p.toLowerCase().includes(q));

      const filteredConfigured = filterGroup(configured);
      const filteredPopular = filterGroup(popular);
      const filteredAll = filterGroup(all);

      const providerItems: PickerItem[] = [];

      if (filteredConfigured.length > 0) {
        providerItems.push({ id: '__header__configured', label: 'Configured', isGroupHeader: true });
        for (const p of filteredConfigured) {
          providerItems.push({ id: p, label: p, isConfigured: true });
        }
      }
      if (filteredPopular.length > 0) {
        providerItems.push({ id: '__header__popular', label: 'Popular', isGroupHeader: true });
        for (const p of filteredPopular) {
          providerItems.push({ id: p, label: p });
        }
      }
      if (filteredAll.length > 0) {
        providerItems.push({ id: '__header__all', label: 'All', isGroupHeader: true });
        for (const p of filteredAll) {
          providerItems.push({ id: p, label: p });
        }
      }

      return providerItems;
    }
    // effort mode
    return this.effortLevels.map(e => ({ id: e, label: e, detail: EFFORT_DESCRIPTIONS[e] ?? '' }));
  }

  /** Build a PickerItem for a model, including quality tier and pin status. */
  private _modelToItem(model: ModelDefinition, isPinned: boolean): PickerItem {
    const b = getBenchmarks(model.id) ?? getBenchmarks(model.displayName);
    const qualityTier = b ? getQualityTier(b.benchmarks) : undefined;
    const isFree = tierToCategoryFilter(model.tier) === 'free';

    // For synthetic models, append provider count info if available
    let detail = model.provider;
    if (model.provider === 'synthetic') {
      const info = getSyntheticModelInfo(model.id);
      if (info !== null) {
        detail = `${model.provider} [${info.backendCount} provider${info.backendCount !== 1 ? 's' : ''}]`;
      }
    }

    return {
      id: model.id,
      label: model.displayName,
      detail,
      qualityTier,
      isPinned,
      isFree,
    };
  }

  /** Get count of selectable (non-header) items in current mode. */
  getItemCount(): number {
    if (this.mode === 'model') return this.getFilteredModels().length;
    if (this.mode === 'provider') return this.getFilteredProviders().length;
    return this.effortLevels.length;
  }

  /**
   * Move selection up (stops at 0 — no wrap to avoid going off-screen).
   * Updates scrollOffset to keep selection visible.
   */
  moveUp(maxVisible = 20): void {
    const count = this.getItemCount();
    if (count === 0) return;
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this._scrollToSelection(maxVisible);
    }
    // At index 0 — stop. Do NOT wrap to count-1 (that puts selection off-screen).
  }

  /**
   * Move selection down (wraps to 0 at bottom).
   * Updates scrollOffset to keep selection visible.
   */
  moveDown(maxVisible = 20): void {
    const count = this.getItemCount();
    if (count === 0) return;
    this.selectedIndex = this.selectedIndex < count - 1
      ? this.selectedIndex + 1
      : 0;
    this._scrollToSelection(maxVisible);
  }

  /** Get the currently highlighted model, or null if not in model mode / empty. */
  getSelected(): ModelDefinition | null {
    if (this.mode !== 'model') return null;
    const filtered = this.getFilteredModels();
    if (filtered.length === 0) return null;
    return filtered[this.selectedIndex] ?? null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _clampSelection(): void {
    const count = this.getItemCount();
    if (count === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    } else if (this.selectedIndex >= count) {
      this.selectedIndex = count - 1;
    }
    // Clamp scrollOffset too
    const maxOffset = Math.max(0, count - 1);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
  }

  /**
   * Adjust scrollOffset so selectedIndex is within the visible window [scrollOffset, scrollOffset + maxVisible).
   * Called after every navigation action.
   */
  _scrollToSelection(maxVisible: number): void {
    if (this.selectedIndex < this.scrollOffset) {
      // Selection moved above viewport — scroll up
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + maxVisible) {
      // Selection moved below viewport — scroll down
      this.scrollOffset = this.selectedIndex - maxVisible + 1;
    }
  }
}
