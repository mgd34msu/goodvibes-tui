import type { ModelDefinition } from '../providers/registry.ts';

export type PickerMode = 'model' | 'provider' | 'effort';

/** A generic selectable item for non-model modes. */
export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
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

  /** Open showing all models — entry point for /model */
  openAllModels(models: ModelDefinition[], currentModelId: string): void {
    this.models = models;
    this.mode = 'model';
    this.active = true;
    this.pendingModel = null;
    const idx = models.findIndex(m => m.id === currentModelId);
    this.selectedIndex = idx >= 0 ? idx : 0;
  }

  /** Open showing providers first — entry point for /provider */
  openProviders(providers: string[], currentProvider: string): void {
    this.providers = providers;
    this.mode = 'provider';
    this.active = true;
    this.pendingModel = null;
    const idx = providers.indexOf(currentProvider);
    this.selectedIndex = idx >= 0 ? idx : 0;
  }

  /** Transition to model list filtered by provider (called from provider mode Enter). */
  showModelsForProvider(models: ModelDefinition[], _provider: string): void {
    this.models = models;
    this.mode = 'model';
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
  }

  /** Get the items for the current mode as a unified list. */
  getItems(): PickerItem[] {
    if (this.mode === 'model') {
      return this.models.map(m => ({ id: m.id, label: m.displayName, detail: m.provider }));
    }
    if (this.mode === 'provider') {
      return this.providers.map(p => ({ id: p, label: p }));
    }
    // effort mode
    const descriptions: Record<string, string> = {
      instant: 'Fastest, minimal reasoning',
      low: 'Quick with light reasoning',
      medium: 'Balanced speed and quality',
      high: 'Thorough, deep reasoning',
    };
    return this.effortLevels.map(e => ({ id: e, label: e, detail: descriptions[e] ?? '' }));
  }

  /** Get count of items in current mode. */
  getItemCount(): number {
    if (this.mode === 'model') return this.models.length;
    if (this.mode === 'provider') return this.providers.length;
    return this.effortLevels.length;
  }

  /** Move selection up (wraps). */
  moveUp(): void {
    const count = this.getItemCount();
    if (count === 0) return;
    this.selectedIndex = this.selectedIndex > 0
      ? this.selectedIndex - 1
      : count - 1;
  }

  /** Move selection down (wraps). */
  moveDown(): void {
    const count = this.getItemCount();
    if (count === 0) return;
    this.selectedIndex = this.selectedIndex < count - 1
      ? this.selectedIndex + 1
      : 0;
  }

  /** Get the currently highlighted model, or null if not in model mode / empty. */
  getSelected(): ModelDefinition | null {
    if (this.mode !== 'model' || this.models.length === 0) return null;
    return this.models[this.selectedIndex] ?? null;
  }
}
