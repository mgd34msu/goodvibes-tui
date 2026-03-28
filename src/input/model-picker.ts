import type { ModelDefinition } from '../providers/registry.ts';
import { EFFORT_DESCRIPTIONS } from '../providers/effort-levels.ts';

export type PickerMode = 'model' | 'provider' | 'effort';
export type CategoryFilter = 'all' | 'free' | 'premium';

/** A generic selectable item for non-model modes. */
export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  /** If true, this item is a provider group header (not selectable). */
  isGroupHeader?: boolean;
}

/**
 * ModelPickerModal - Multi-step interactive picker for model, provider, and effort.
 * Supports three modes: 'model', 'provider', 'effort'.
 */
export class ModelPickerModal {
  public active = false;
  public mode: PickerMode = 'model';
  public selectedIndex = 0;
  public models: ModelDefinition[] = [];
  public providers: string[] = [];
  public effortLevels: string[] = [];
  /** The model chosen in model-mode, awaiting effort selection. */
  public pendingModel: ModelDefinition | null = null;

  // ── Search / filter ────────────────────────────────────────────────────────
  /** Current search query string (empty = no filter). */
  public query = '';
  /** Active category filter. */
  public categoryFilter: CategoryFilter = 'all';

  /** Open showing all models — entry point for /model */
  openAllModels(models: ModelDefinition[], currentModelId: string): void {
    this.models = models;
    this.mode = 'model';
    this.active = true;
    this.pendingModel = null;
    this.query = '';
    this.categoryFilter = 'all';
    const filtered = this.getFilteredModels();
    const idx = filtered.findIndex(m => m.id === currentModelId);
    this.selectedIndex = idx >= 0 ? idx : 0;
  }

  /** Open showing providers first — entry point for /provider */
  openProviders(providers: string[], currentProvider: string): void {
    this.providers = providers;
    this.mode = 'provider';
    this.active = true;
    this.pendingModel = null;
    this.query = '';
    this.categoryFilter = 'all';
    const idx = providers.indexOf(currentProvider);
    this.selectedIndex = idx >= 0 ? idx : 0;
  }

  /** Transition to model list filtered by provider (called from provider mode Enter). */
  showModelsForProvider(models: ModelDefinition[], _provider: string): void {
    this.models = models;
    this.mode = 'model';
    this.query = '';
    this.categoryFilter = 'all';
    this.selectedIndex = 0;
  }

  /** Transition to effort picker after model is chosen. */
  showEffortPicker(model: ModelDefinition, currentEffort: string): void {
    this.pendingModel = model;
    this.effortLevels = model.reasoningEffort ?? [];
    this.mode = 'effort';
    const idx = this.effortLevels.indexOf(currentEffort);
    this.selectedIndex = idx >= 0 ? idx : 0;
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
    this.query = '';
    this.categoryFilter = 'all';
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

  /** Return models matching the current query and categoryFilter. */
  getFilteredModels(): ModelDefinition[] {
    let result = this.models;

    // Category filter
    if (this.categoryFilter === 'free') {
      result = result.filter(m => m.tier === 'free');
    } else if (this.categoryFilter === 'premium') {
      result = result.filter(m => m.tier === 'premium');
    }

    // Query filter — fuzzy: every space-separated word must appear somewhere
    if (this.query.trim().length > 0) {
      const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      result = result.filter(m => {
        const haystack = `${m.id} ${m.displayName} ${m.provider}`.toLowerCase();
        return words.every(w => haystack.includes(w));
      });
    }

    return result;
  }

  /** Get the items for the current mode as a unified list. */
  getItems(): PickerItem[] {
    if (this.mode === 'model') {
      const filtered = this.getFilteredModels();
      // Build grouped list with provider headers
      const items: PickerItem[] = [];
      let lastProvider = '';
      for (const m of filtered) {
        if (m.provider !== lastProvider) {
          items.push({ id: `__header__${m.provider}`, label: m.provider, isGroupHeader: true });
          lastProvider = m.provider;
        }
        items.push({ id: m.id, label: m.displayName, detail: m.provider });
      }
      return items;
    }
    if (this.mode === 'provider') {
      return this.providers.map(p => ({ id: p, label: p }));
    }
    // effort mode
    return this.effortLevels.map(e => ({ id: e, label: e, detail: EFFORT_DESCRIPTIONS[e] ?? '' }));
  }

  /** Get count of selectable (non-header) items in current mode. */
  getItemCount(): number {
    if (this.mode === 'model') return this.getFilteredModels().length;
    if (this.mode === 'provider') return this.providers.length;
    return this.effortLevels.length;
  }

  /** Move selection up (wraps, skips headers). */
  moveUp(): void {
    const count = this.getItemCount();
    if (count === 0) return;
    this.selectedIndex = this.selectedIndex > 0
      ? this.selectedIndex - 1
      : count - 1;
  }

  /** Move selection down (wraps, skips headers). */
  moveDown(): void {
    const count = this.getItemCount();
    if (count === 0) return;
    this.selectedIndex = this.selectedIndex < count - 1
      ? this.selectedIndex + 1
      : 0;
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
    } else if (this.selectedIndex >= count) {
      this.selectedIndex = count - 1;
    }
  }
}
