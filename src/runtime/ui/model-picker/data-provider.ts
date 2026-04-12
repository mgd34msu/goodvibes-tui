/**
 * ModelPickerDataProvider — enriched model picker data surface.
 *
 * Combines ModelDefinition records from the provider registry with
 * ProviderHealthDomainState and ModelDomainState to produce a single,
 * sorted, health-enriched ModelPickerData snapshot for UI consumption.
 *
 * This class is a data provider only — it contains no rendering logic.
 * Subscribe to change notifications and call getSnapshot() to render.
 */
import type { ModelDefinition } from '../../../providers/registry.ts';
import type { ProviderRegistry } from '../../../providers/registry.ts';
import type { BenchmarkStore } from '../../../providers/model-benchmarks.ts';
import type { ProviderHealthDomainState } from '../../store/domains/provider-health.ts';
import type { ModelDomainState } from '../../store/domains/model.ts';
import { enrichModelEntries, groupEntriesByProvider } from './health-enrichment.ts';
import type { ModelPickerData, ModelPickerEntry } from './types.ts';

/** Options for constructing a ModelPickerDataProvider. */
export interface ModelPickerDataProviderOptions {
  /**
   * Initial set of pinned model IDs.
   * Call updatePinnedIds() to update at runtime.
   */
  readonly pinnedIds?: ReadonlySet<string>;
  readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog' | 'getContextWindowForModel'>;
}

/**
 * ModelPickerDataProvider produces enriched model picker data snapshots.
 *
 * Usage:
 * ```ts
 * const provider = new ModelPickerDataProvider(models, healthState, modelState);
 * const unsub = provider.subscribe(() => {
 *   const data = provider.getSnapshot();
 *   // render data.entries or data.groups
 * });
 * // When health or model state changes:
 * provider.updateHealthState(newHealthState);
 * provider.updateModelState(newModelState);
 * // Cleanup:
 * unsub();
 * provider.dispose();
 * ```
 */
export class ModelPickerDataProvider {
  private _models: readonly ModelDefinition[];
  private _healthState: ProviderHealthDomainState;
  private _modelState: ModelDomainState;
  private _pinnedIds: ReadonlySet<string>;
  private _snapshot: ModelPickerData;
  private readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>;
  private readonly providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog' | 'getContextWindowForModel'>;
  private readonly _subscribers = new Set<() => void>();

  constructor(
    models: readonly ModelDefinition[],
    healthState: ProviderHealthDomainState,
    modelState: ModelDomainState,
    options: ModelPickerDataProviderOptions,
  ) {
    this._models = models;
    this._healthState = healthState;
    this._modelState = modelState;
    this._pinnedIds = options.pinnedIds ?? new Set();
    this.benchmarkStore = options.benchmarkStore;
    this.providerRegistry = options.providerRegistry;
    this._snapshot = this._buildSnapshot();
  }

  /**
   * Return the current enriched model picker data snapshot.
   * This is updated synchronously when state changes via update methods.
   */
  public getSnapshot(): ModelPickerData {
    return this._snapshot;
  }

  /**
   * Register a callback invoked whenever the snapshot changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Update the model list (e.g. after registry reload).
   * Triggers a snapshot rebuild and notifies subscribers.
   */
  public updateModels(models: readonly ModelDefinition[]): void {
    this._models = models;
    this._rebuild();
  }

  /**
   * Update health state (e.g. on ProviderHealthDomainState change).
   * Triggers a snapshot rebuild and notifies subscribers.
   */
  public updateHealthState(healthState: ProviderHealthDomainState): void {
    this._healthState = healthState;
    this._rebuild();
  }

  /**
   * Update model domain state (e.g. on active model or fallback change).
   * Triggers a snapshot rebuild and notifies subscribers.
   */
  public updateModelState(modelState: ModelDomainState): void {
    this._modelState = modelState;
    this._rebuild();
  }

  /**
   * Update the pinned/favorites model ID set.
   * Triggers a snapshot rebuild and notifies subscribers.
   */
  public updatePinnedIds(pinnedIds: ReadonlySet<string>): void {
    this._pinnedIds = pinnedIds;
    this._rebuild();
  }

  /**
   * Release all subscriber references.
   * Does not clear internal state — getSnapshot() remains usable after disposal.
   */
  public dispose(): void {
    this._subscribers.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _rebuild(): void {
    this._snapshot = this._buildSnapshot();
    this._notify();
  }

  private _buildSnapshot(): ModelPickerData {
    const entries: readonly ModelPickerEntry[] = enrichModelEntries(
      this._models,
      this._healthState,
      this._modelState,
      this._pinnedIds,
      this.benchmarkStore,
      this.providerRegistry,
    );

    const groups = groupEntriesByProvider(entries);

    const degradedProviderIds: string[] = [];
    const unavailableProviderIds: string[] = [];
    for (const [id, record] of this._healthState.providers) {
      if (record.status === 'degraded' || record.status === 'rate_limited') {
        degradedProviderIds.push(id);
      } else if (record.status === 'unavailable' || record.status === 'auth_error') {
        unavailableProviderIds.push(id);
      }
    }

    return {
      entries,
      groups,
      degradedProviderIds,
      unavailableProviderIds,
      activeModelId: this._modelState.activeModelId,
      snapshotAt: Date.now(),
    };
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Non-fatal: subscriber errors must not crash the provider
      }
    }
  }
}
