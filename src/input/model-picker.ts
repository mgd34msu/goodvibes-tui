import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import type { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers';
import type { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { detectFamily, POPULAR_PROVIDERS, tierToCategoryFilter } from './model-picker-types.ts';
import type {
  BenchmarkSort,
  CapabilityFilter,
  CategoryFilter,
  FilteredModelsCache,
  FilteredProvidersCache,
  GroupByMode,
  ModelItemsCache,
  ModelPickerFocusPane,
  ModelPickerTarget,
  ModelPickerTargetInfo,
  PickerItem,
  PickerMode,
  ProviderItemsCache,
} from './model-picker-types.ts';
import { filterProviders, groupProviders } from './model-picker-provider-filter.ts';
import {
  buildFilteredModels,
  buildFilteredProviders,
  getSyntheticSubgroup,
  setKey,
  orderedListKey,
  mapKey,
} from './model-picker-filter.ts';
import {
  buildModelItems,
  buildProviderItems,
  buildEffortItems,
  getModelGroupKey,
  toModelItem,
} from './model-picker-items.ts';

export { detectFamily, POPULAR_PROVIDERS, tierToCategoryFilter } from './model-picker-types.ts';
export type {
  BenchmarkSort,
  CapabilityFilter,
  CategoryFilter,
  GroupByMode,
  ModelFamily,
  ModelPickerFocusPane,
  ModelPickerTarget,
  ModelPickerTargetInfo,
  PickerItem,
  PickerMode,
} from './model-picker-types.ts';

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
    private readonly providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog' | 'getSyntheticCanonicalModels'>,
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
  /** Validation error from the last context cap commit (e.g. out-of-range value); null when no error. */
  public contextCapError: string | null = null;

  // ── Search / filter ─────────────────────────────────────────────────────────────────────────────
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

  // ── Category filter cycling ───────────────────────────────────────────────────
  private static readonly CATEGORY_CYCLE: CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
  /** Cycle to next pricing tier filter. */
  cycleCategory(): void {
    const idx = ModelPickerModal.CATEGORY_CYCLE.indexOf(this.categoryFilter);
    this.categoryFilter = ModelPickerModal.CATEGORY_CYCLE[(idx + 1) % ModelPickerModal.CATEGORY_CYCLE.length];
    this.clearFilteredCaches();
    this._clampSelection();
  }

  // ── Group-by cycling ────────────────────────────────────────────────────────────────
  private static readonly GROUP_BY_CYCLE: GroupByMode[] = ['provider', 'family', 'pricingTier', 'qualityTier'];
  /** Cycle to next group-by mode. */
  cycleGroupBy(): void {
    const idx = ModelPickerModal.GROUP_BY_CYCLE.indexOf(this.groupBy);
    this.groupBy = ModelPickerModal.GROUP_BY_CYCLE[(idx + 1) % ModelPickerModal.GROUP_BY_CYCLE.length];
    this.clearFilteredCaches();
    this._clampSelection();
  }

  // ── Benchmark sort cycling ───────────────────────────────────────────────────────────────
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
    this.contextCapError = null;
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
    this.availableOnly = true;
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
    this.contextCapError = null;
    this.searchFocused = false;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.query = '';
    this.categoryFilter = 'all';
    this.capabilityFilter = 'none';
    this.clearCaches();
  }

  // ── Search helpers ─────────────────────────────────────────────────────────────────────

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
    const { result, cache } = buildFilteredProviders(
      this.providers,
      this.query,
      this.filteredProvidersCache,
    );
    this.filteredProvidersCache = cache;
    return result;
  }

  /** Return models matching all current filters, sorted per benchmarkSort. */
  getFilteredModels(): ModelDefinition[] {
    const { result, cache } = buildFilteredModels(
      {
        models: this.models,
        configuredProviders: this.configuredProviders,
        pinnedIds: this.pinnedIds,
        recentIds: this.recentIds,
        query: this.query,
        categoryFilter: this.categoryFilter,
        capabilityFilter: this.capabilityFilter,
        availableOnly: this.availableOnly,
        benchmarkSort: this.benchmarkSort,
        groupBy: this.groupBy,
        benchmarkStore: this.benchmarkStore,
        providerRegistry: this.providerRegistry,
      },
      this.filteredModelsCache,
    );
    this.filteredModelsCache = cache;
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
    return getModelGroupKey(model, this.groupBy, this.providerRegistry, this.benchmarkStore);
  }

  /** Get the items for the current mode as a unified list. */
  getItems(): PickerItem[] {
    if (this.mode === 'model') {
      const filtered = this.getFilteredModels();
      const { result, cache } = buildModelItems(
        filtered,
        this.pinnedIds,
        this.groupBy,
        this.providerRegistry,
        this.benchmarkStore,
        this.modelItemsCache,
      );
      this.modelItemsCache = cache;
      return result;
    }
    if (this.mode === 'provider') {
      const filteredProviders = this.getFilteredProviders();
      const { result, cache } = buildProviderItems(
        filteredProviders,
        this.configuredProviders,
        this.configuredViaMap,
        this.providerItemsCache,
      );
      this.providerItemsCache = cache;
      return result;
    }
    // effort mode
    return buildEffortItems(this.effortLevels);
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

  // ── Private helpers ─────────────────────────────────────────────────────────────────────

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

  /**
   * Returns the ordered backend ladder for a synthetic model.
   * Each entry describes a real provider/model that the synthetic model routes to.
   * Returns null when the model ID is not found in the synthetic catalog.
   */
  getSyntheticChain(modelId: string): Array<{ position: number; provider: string; model: string; registryKey: string }> | null {
    const canonical = this.providerRegistry.getSyntheticCanonicalModels();
    const entry = canonical.find((m) => m.id === modelId);
    if (!entry) return null;
    return entry.backends.map((b, idx) => ({
      position: idx,
      provider: b.providerName,
      model: b.modelId,
      registryKey: b.registryKey ?? `${b.providerName}:${b.modelId}`,
    }));
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
