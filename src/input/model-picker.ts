import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers';
import { EFFORT_DESCRIPTIONS } from '@pellux/goodvibes-sdk/platform/providers';
import { getQualityTier, getQualityTierFromScore, compositeScore, A_TIER_THRESHOLD } from '@pellux/goodvibes-sdk/platform/providers';
import type { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { detectFamily, POPULAR_PROVIDERS, tierToCategoryFilter } from './model-picker-types.ts';
import type { BenchmarkSort, CapabilityFilter, CategoryFilter, FilteredModelsCache, FilteredProvidersCache, GroupByMode, ModelItemsCache, ModelPickerFocusPane, ModelPickerTarget, ModelPickerTargetInfo, PickerItem, PickerMode, ProviderItemsCache } from './model-picker-types.ts';
import { filterProviders, groupProviders } from './model-picker-provider-filter.ts';

export { detectFamily, POPULAR_PROVIDERS, tierToCategoryFilter } from './model-picker-types.ts';
export type { BenchmarkSort, CapabilityFilter, CategoryFilter, GroupByMode, ModelFamily, ModelPickerFocusPane, ModelPickerTarget, ModelPickerTargetInfo, PickerItem, PickerMode } from './model-picker-types.ts';

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
  constructor(
    private readonly favoritesStore: Pick<FavoritesStore, 'getRecentModels'>,
    private readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>,
    private readonly providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>,
  ) {}

  public active = false;
  public mode: PickerMode = 'model';
  /** Which config target this picker session will write to on commit. */
  public target: ModelPickerTarget = 'main';
  public focusPane: ModelPickerFocusPane = 'items';
  public targetInfos: ModelPickerTargetInfo[] = [];
  public targetIndex = 0;
  public searchFocused = false;
  /** Tracks the mode we came from, for back-navigation. */
  public previousMode: PickerMode | null = null;
  public selectedIndex = 0;
  /** Scroll offset for the visible item window (tracks first visible item index). */
  public scrollOffset = 0;
  public models: ModelDefinition[] = [];
  public providers: string[] = [];
  public effortLevels: string[] = [];
  /** The model chosen in model-mode, awaiting effort selection. */
  public pendingModel: ModelDefinition | null = null;
  /** The model awaiting context cap input (contextCap mode). */
  public contextCapPendingModel: ModelDefinition | null = null;
  /** Current input string in contextCap mode. */
  public contextCapQuery = '';

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
  /** How each provider is configured — drives badge display in provider mode. */
  public configuredViaMap: Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'> = new Map();
  /** IDs of pinned/favorite models — shown at top of list. */
  public pinnedIds: Set<string> = new Set();
  /** IDs of recently used models — shown after pinned, before the rest. */
  public recentIds: string[] = [];
  /** Benchmark score sort order. */
  public benchmarkSort: BenchmarkSort = 'none';
  /** Current group-by mode. */
  public groupBy: GroupByMode = 'provider';

  private filteredModelsCache: FilteredModelsCache | null = null;
  private filteredProvidersCache: FilteredProvidersCache | null = null;
  private modelItemsCache: ModelItemsCache | null = null;
  private providerItemsCache: ProviderItemsCache | null = null;

  setTargetInfos(infos: ModelPickerTargetInfo[]): void {
    this.targetInfos = infos;
    const idx = infos.findIndex((entry) => entry.target === this.target);
    this.targetIndex = idx >= 0 ? idx : 0;
  }

  getSelectedTargetInfo(): ModelPickerTargetInfo | null {
    return this.targetInfos[this.targetIndex] ?? null;
  }

  focusTargets(): void {
    this.focusPane = 'targets';
    this.searchFocused = false;
  }

  focusItems(): void {
    this.focusPane = 'items';
  }

  moveTarget(delta: number): void {
    if (this.targetInfos.length === 0) return;
    const nextIndex = (this.targetIndex + delta + this.targetInfos.length) % this.targetInfos.length;
    this.setTarget(this.targetInfos[nextIndex]!.target);
  }

  setTarget(target: ModelPickerTarget): void {
    this.target = target;
    const idx = this.targetInfos.findIndex((entry) => entry.target === target);
    this.targetIndex = idx >= 0 ? idx : this.targetIndex;
    this.alignSelectionToTarget();
  }

  alignSelectionToTarget(): void {
    const info = this.getSelectedTargetInfo();
    if (!info) return;
    if (this.mode === 'provider') {
      const providers = this.getFilteredProviders();
      const providerIdx = providers.findIndex((provider) => provider === info.provider);
      this.selectedIndex = providerIdx >= 0 ? providerIdx : 0;
      this.scrollOffset = 0;
      this._scrollToSelection(20);
      return;
    }
    if (this.mode === 'model') {
      const models = this.getFilteredModels();
      const modelIdx = models.findIndex((model) => model.registryKey === info.model || model.id === info.model);
      this.selectedIndex = modelIdx >= 0 ? modelIdx : 0;
      this.scrollOffset = 0;
      this._scrollToSelection(20);
    }
  }

  // ── Category filter cycling ───────────────────────────────────────────────
  private static readonly CATEGORY_CYCLE: CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
  /** Cycle to next pricing tier filter. */
  cycleCategory(): void {
    const idx = ModelPickerModal.CATEGORY_CYCLE.indexOf(this.categoryFilter);
    this.categoryFilter = ModelPickerModal.CATEGORY_CYCLE[(idx + 1) % ModelPickerModal.CATEGORY_CYCLE.length];
    this.clearFilteredCaches();
    this._clampSelection();
  }

  // ── Group-by cycling ──────────────────────────────────────────────────────
  private static readonly GROUP_BY_CYCLE: GroupByMode[] = ['provider', 'family', 'pricingTier', 'qualityTier'];
  /** Cycle to next group-by mode. */
  cycleGroupBy(): void {
    const idx = ModelPickerModal.GROUP_BY_CYCLE.indexOf(this.groupBy);
    this.groupBy = ModelPickerModal.GROUP_BY_CYCLE[(idx + 1) % ModelPickerModal.GROUP_BY_CYCLE.length];
    this.clearFilteredCaches();
    this._clampSelection();
  }

  // ── Benchmark sort cycling ────────────────────────────────────────────────
  private static readonly BENCHMARK_SORT_CYCLE: BenchmarkSort[] = ['none', 'composite', 'swe', 'gpqa'];
  /** Cycle to next benchmark sort order. */
  cycleBenchmarkSort(): void {
    const idx = ModelPickerModal.BENCHMARK_SORT_CYCLE.indexOf(this.benchmarkSort);
    this.benchmarkSort = ModelPickerModal.BENCHMARK_SORT_CYCLE[(idx + 1) % ModelPickerModal.BENCHMARK_SORT_CYCLE.length];
    this.clearFilteredCaches();
    this._clampSelection();
  }

  /**
   * Return true when a model is from a custom or discovered (local) provider.
   * Local models have `contextWindowProvenance` set; catalog cloud models do not.
   */
  isLocalModel(model: ModelDefinition): boolean {
    return model.contextWindowProvenance !== undefined;
  }

  /** Enter context window cap input mode for a local model. */
  enterContextCapMode(model: ModelDefinition): void {
    this.previousMode = 'model';
    this.contextCapPendingModel = model;
    this.contextCapQuery = '';
    this.mode = 'contextCap';
  }

  /** Append a character to the context cap query. */
  appendContextCapChar(ch: string): void {
    // Only allow digits; limit to 9 characters (max representable: 999_999_999)
    if (this.contextCapQuery.length >= 9) return;
    if (/^[0-9]$/.test(ch)) {
      this.contextCapQuery += ch;
    }
  }

  /** Delete the last character from the context cap query. */
  deleteContextCapChar(): void {
    if (this.contextCapQuery.length > 0) {
      this.contextCapQuery = this.contextCapQuery.slice(0, -1);
    }
  }

  /** Open showing all models — entry point for /model */
  openAllModels(models: ModelDefinition[], currentModelId: string): void {
    this.models = models;
    this.mode = 'model';
    this.active = true;
    this.pendingModel = null;
    this.focusPane = 'items';
    this.searchFocused = false;
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
    this.previousMode = null;
    this.providers = providers;
    this.mode = 'provider';
    this.active = true;
    this.pendingModel = null;
    this.focusPane = 'items';
    this.searchFocused = false;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    const filtered = this.getFilteredProviders();
    const currentIndex = filtered.findIndex((provider) => provider === currentProvider);
    this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
    this.scrollOffset = 0;
  }

  /** Transition to model list filtered by provider (called from provider mode Enter). */
  showModelsForProvider(models: ModelDefinition[], _provider: string): void {
    this.previousMode = 'provider';
    this.models = models;
    this.mode = 'model';
    this.searchFocused = false;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    // User explicitly chose this provider — disable availability filter so synthetic
    // models (which have no real API key) are not filtered out.
    this.availableOnly = false;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  /** Transition to effort picker after model is chosen. */
  showEffortPicker(model: ModelDefinition, currentEffort: string): void {
    this.previousMode = 'model';
    this.pendingModel = model;
    this.searchFocused = false;
    this.effortLevels = model.reasoningEffort ?? [];
    this.mode = 'effort';
    const idx = this.effortLevels.indexOf(currentEffort);
    this.selectedIndex = idx >= 0 ? idx : 0;
    this.scrollOffset = 0;
  }

  /** Close the picker entirely. */
  close(): void {
    this.active = false;
    this.mode = 'model';
    this.target = 'main';
    this.focusPane = 'items';
    this.targetInfos = [];
    this.targetIndex = 0;
    this.models = [];
    this.providers = [];
    this.pendingModel = null;
    this.contextCapPendingModel = null;
    this.contextCapQuery = '';
    this.searchFocused = false;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    this.clearCaches();
  }

  // ── Search helpers ─────────────────────────────────────────────────────────

  /** Append a character to the search query and clamp selectedIndex. */
  appendChar(ch: string): void {
    this.query += ch;
    this.clearFilteredCaches();
    this._clampSelection();
  }

  /** Delete the last character from the search query and clamp selectedIndex. */
  deleteChar(): void {
    if (this.query.length > 0) {
      this.query = this.query.slice(0, -1);
      this.clearFilteredCaches();
      this._clampSelection();
    }
  }

  /** Clear the search query and clamp selectedIndex. */
  clearQuery(): void {
    this.query = '';
    this.clearFilteredCaches();
    this._clampSelection();
  }

  canFocusSearch(): boolean {
    return this.mode === 'model' || this.mode === 'provider';
  }

  focusSearch(): void {
    if (this.canFocusSearch()) this.searchFocused = true;
  }

  blurSearch(): void {
    this.searchFocused = false;
  }

  /** Set category filter and clamp selectedIndex. */
  setCategoryFilter(filter: CategoryFilter): void {
    this.categoryFilter = filter;
    this.clearFilteredCaches();
    this._clampSelection();
  }

  /** Set capability filter and clamp selectedIndex. */
  setCapabilityFilter(filter: CapabilityFilter): void {
    this.capabilityFilter = filter;
    this.clearFilteredCaches();
    this._clampSelection();
  }

  /** Toggle the available-only filter. */
  toggleAvailableOnly(): void {
    this.availableOnly = !this.availableOnly;
    this.clearFilteredCaches();
    this._clampSelection();
  }

  /**
   * Split providers into two ordered groups: Popular, All.
   * Each group is alphabetized. Popular contains providers in POPULAR_PROVIDERS;
   * All contains the rest. Configuration status is shown via checkmarks in the
   * renderer and does not affect grouping.
   */
  getGroupedProviders(): { popular: string[]; all: string[] } {
    return groupProviders(this.providers);
  }

  /** Return providers matching the current query (case-insensitive substring), in grouped order. */
  getFilteredProviders(): string[] {
    const cached = this.filteredProvidersCache;
    if (
      cached !== null
      && cached.providersRef === this.providers
      && cached.query === this.query
    ) {
      return cached.result;
    }

    const result = filterProviders(this.providers, this.query);
    this.filteredProvidersCache = {
      providersRef: this.providers,
      query: this.query,
      result,
    };
    return result;
  }

  /** Return models matching all current filters, sorted per benchmarkSort. */
  getFilteredModels(): ModelDefinition[] {
    const configuredProvidersKey = setKey(this.configuredProviders);
    const pinnedIdsKey = setKey(this.pinnedIds);
    const recentIdsKey = orderedListKey(this.recentIds);
    const cached = this.filteredModelsCache;
    if (
      cached !== null
      && cached.modelsRef === this.models
      && cached.configuredProvidersKey === configuredProvidersKey
      && cached.pinnedIdsKey === pinnedIdsKey
      && cached.recentIdsKey === recentIdsKey
      && cached.query === this.query
      && cached.categoryFilter === this.categoryFilter
      && cached.capabilityFilter === this.capabilityFilter
      && cached.availableOnly === this.availableOnly
      && cached.benchmarkSort === this.benchmarkSort
      && cached.groupBy === this.groupBy
    ) {
      return cached.result;
    }

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
        let scoreA: number | null = null;
        let scoreB: number | null = null;

        // For synthetic models, use pre-computed bestCompositeScore from backend lookup
        // (synthetic canonical slugs don't exist in ZeroEval benchmark data)
        if (this.benchmarkSort === 'composite') {
          if (a.provider === 'synthetic') {
            scoreA = this.providerRegistry.getSyntheticModelInfoFromCatalog(a.id)?.bestCompositeScore ?? null;
          } else {
            const bA = this.benchmarkStore.getBenchmarks(a.id) ?? this.benchmarkStore.getBenchmarks(a.displayName);
            scoreA = bA ? compositeScore(bA.benchmarks) : null;
          }
          if (b.provider === 'synthetic') {
            scoreB = this.providerRegistry.getSyntheticModelInfoFromCatalog(b.id)?.bestCompositeScore ?? null;
          } else {
            const bB = this.benchmarkStore.getBenchmarks(b.id) ?? this.benchmarkStore.getBenchmarks(b.displayName);
            scoreB = bB ? compositeScore(bB.benchmarks) : null;
          }
        } else {
          // swe/gpqa sort — individual benchmark scores not available for synthetic models — only composite is cached
          const bA = a.provider === 'synthetic' ? null : (this.benchmarkStore.getBenchmarks(a.id) ?? this.benchmarkStore.getBenchmarks(a.displayName));
          const bB = b.provider === 'synthetic' ? null : (this.benchmarkStore.getBenchmarks(b.id) ?? this.benchmarkStore.getBenchmarks(b.displayName));
          if (this.benchmarkSort === 'swe') {
            scoreA = bA?.benchmarks.swe ?? null;
            scoreB = bB?.benchmarks.swe ?? null;
          } else if (this.benchmarkSort === 'gpqa') {
            scoreA = bA?.benchmarks.gpqa ?? null;
            scoreB = bB?.benchmarks.gpqa ?? null;
          }
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
          const sA = this.providerRegistry.getSyntheticModelInfoFromCatalog(a.id)?.bestCompositeScore ?? null;
          const sB = this.providerRegistry.getSyntheticModelInfoFromCatalog(b.id)?.bestCompositeScore ?? null;
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

    // Boost recent (non-pinned) models to the front of the list,
    // preserving relative order within the recent group and within the rest.
    if (this.recentIds.length > 0) {
      const recentSet = new Set(this.recentIds);
      const recent = this.recentIds
        .filter(id => result.some(m => m.id === id && !this.pinnedIds.has(id)))
        .map(id => result.find(m => m.id === id)!)
        .filter(Boolean);
      const rest = result.filter(m => !recentSet.has(m.id) || this.pinnedIds.has(m.id));
      result = [...recent, ...rest];
    }

    this.filteredModelsCache = {
      modelsRef: this.models,
      configuredProvidersKey,
      pinnedIdsKey,
      recentIdsKey,
      query: this.query,
      categoryFilter: this.categoryFilter,
      capabilityFilter: this.capabilityFilter,
      availableOnly: this.availableOnly,
      benchmarkSort: this.benchmarkSort,
      groupBy: this.groupBy,
      result,
    };
    this.modelItemsCache = null;
    return result;
  }

  /**
   * Load recently used model IDs from favorites and cache them in recentIds.
   * Call this when opening the picker to ensure recent models appear near the top.
   */
  async loadRecentModels(n = 10): Promise<void> {
    this.recentIds = await this.favoritesStore.getRecentModels(n);
    this.clearFilteredCaches();
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
        if (model.provider === 'synthetic') {
          const info = this.providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
          return info?.bestCompositeScore != null ? getQualityTierFromScore(info.bestCompositeScore) : 'C';
        }
        const b = this.benchmarkStore.getBenchmarks(model.id) ?? this.benchmarkStore.getBenchmarks(model.displayName);
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
    const info = this.providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
    const score = info?.bestCompositeScore ?? null;
    return score !== null && score >= A_TIER_THRESHOLD ? 'top' : 'all';
  }

  /** Get the items for the current mode as a unified list. */
  getItems(): PickerItem[] {
    if (this.mode === 'model') {
      const filtered = this.getFilteredModels();
      const pinnedIdsKey = setKey(this.pinnedIds);
      const cached = this.modelItemsCache;
      if (
        cached !== null
        && cached.filteredModelsRef === filtered
        && cached.pinnedIdsKey === pinnedIdsKey
        && cached.groupBy === this.groupBy
      ) {
        return cached.result;
      }

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

      this.modelItemsCache = {
        filteredModelsRef: filtered,
        pinnedIdsKey,
        groupBy: this.groupBy,
        result: items,
      };
      return items;
    }
    if (this.mode === 'provider') {
      const filteredProviders = this.getFilteredProviders();
      const configuredProvidersKey = setKey(this.configuredProviders);
      const configuredViaKey = mapKey(this.configuredViaMap);
      const cached = this.providerItemsCache;
      if (
        cached !== null
        && cached.filteredProvidersRef === filteredProviders
        && cached.configuredProvidersKey === configuredProvidersKey
        && cached.configuredViaKey === configuredViaKey
      ) {
        return cached.result;
      }

      const providerItems: PickerItem[] = [];
      let currentGroup: 'Popular' | 'All Providers' | null = null;
      for (const p of filteredProviders) {
        const group: 'Popular' | 'All Providers' = POPULAR_PROVIDERS.has(p.toLowerCase()) ? 'Popular' : 'All Providers';
        if (group !== currentGroup) {
          providerItems.push({ id: `__header__${group}`, label: group, isGroupHeader: true });
          currentGroup = group;
        }
        providerItems.push({ id: p, label: p, isConfigured: this.configuredProviders.has(p), configuredVia: this.configuredViaMap.get(p) });
      }

      this.providerItemsCache = {
        filteredProvidersRef: filteredProviders,
        configuredProvidersKey,
        configuredViaKey,
        result: providerItems,
      };
      return providerItems;
    }
    // effort mode
    return this.effortLevels.map(e => ({ id: e, label: e, detail: EFFORT_DESCRIPTIONS[e] ?? '' }));
  }

  /** Build a PickerItem for a model, including quality tier and pin status. */
  private _modelToItem(model: ModelDefinition, isPinned: boolean): PickerItem {
    // For synthetic models, derive quality tier from cached bestCompositeScore
    // (synthetic canonical slugs don't exist in ZeroEval benchmark data)
    let qualityTier: string | undefined;
    let detail: string;
    if (model.provider === 'synthetic') {
      const synthInfo = this.providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
      if (synthInfo?.bestCompositeScore != null) {
        qualityTier = getQualityTierFromScore(synthInfo.bestCompositeScore);
      }
      // Reuse synthInfo for provider count detail
      detail = synthInfo !== null
        ? `${model.provider} [${synthInfo.keyedBackendCount} provider${synthInfo.keyedBackendCount !== 1 ? 's' : ''}]`
        : model.provider;
    } else {
      detail = model.provider;
      const b = this.benchmarkStore.getBenchmarks(model.id) ?? this.benchmarkStore.getBenchmarks(model.displayName);
      qualityTier = b ? getQualityTier(b.benchmarks) : undefined;
    }
    const isFree = tierToCategoryFilter(model.tier) === 'free';

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

  getSyntheticModelInfo(modelId: string) {
    return this.providerRegistry.getSyntheticModelInfoFromCatalog(modelId);
  }

  getBenchmarkEntry(model: ModelDefinition) {
    return this.benchmarkStore.getBenchmarks(model.id) ?? this.benchmarkStore.getBenchmarks(model.displayName);
  }

  private clearFilteredCaches(): void {
    this.filteredModelsCache = null;
    this.filteredProvidersCache = null;
    this.modelItemsCache = null;
    this.providerItemsCache = null;
  }

  private clearCaches(): void {
    this.clearFilteredCaches();
  }
}

function setKey(values: ReadonlySet<string>): string {
  if (values.size === 0) return '';
  return [...values].sort().join('\u001f');
}

function orderedListKey(values: readonly string[]): string {
  return values.length === 0 ? '' : values.join('\u001f');
}

function mapKey(values: ReadonlyMap<string, string | undefined>): string {
  if (values.size === 0) return '';
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\u001e${value ?? ''}`)
    .join('\u001f');
}
