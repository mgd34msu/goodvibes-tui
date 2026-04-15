/**
 * PluginLifecycleManager — plugin lifecycle and capability enforcement.
 *
 * Tracks all plugins through the 8-state lifecycle machine, resolves capability
 * manifests on load, and emits PluginEvents at every state transition.
 *
 * Gated by the `plugin-lifecycle` feature flag.
 */

import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { PluginEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/plugins';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { RuntimeEventBus as RuntimeEventBusContract } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { PluginLoaderDeps, LoadedPlugin } from '../../plugins/loader';
import {
  discoverPlugins,
  loadPlugin,
  unloadPlugin,
  type PluginPathOptions,
} from '../../plugins/loader';
import type { PluginLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/plugins';
import {
  type PluginCapability,
  type PluginLifecycleManagerOptions,
  type PluginLifecycleRecord,
  type PluginManifestV2,
  type PluginTransition,
  MAX_TRANSITION_HISTORY,
} from '@pellux/goodvibes-sdk/platform/runtime/plugins/types';
import { applyTransition, isOperational } from '@pellux/goodvibes-sdk/platform/runtime/plugins/lifecycle';
import { resolveCapabilityManifest } from '@pellux/goodvibes-sdk/platform/runtime/plugins/manifest';
import { PluginTrustStore, type PluginTrustTier } from '@pellux/goodvibes-sdk/platform/runtime/plugins/trust';
import { PluginQuarantineEngine } from '@pellux/goodvibes-sdk/platform/runtime/plugins/quarantine';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import {
  emitPluginActive,
  emitPluginDegraded,
  emitPluginDisabled,
  emitPluginDiscovered,
  emitPluginError,
  emitPluginLoaded,
  emitPluginLoading,
  emitPluginUnloading,
} from '@pellux/goodvibes-sdk/platform/runtime/emitters/plugins';

/** Source label for emitted events. */
const EVENT_SOURCE = 'plugin-lifecycle-manager';

/**
 * PluginLifecycleManager tracks all plugins through structured lifecycle
 * transitions and emits typed PluginEvents at each state change.
 */
export class PluginLifecycleManager {
  private readonly records = new Map<string, PluginLifecycleRecord>();
  private readonly sessionId: string;
  private readonly capabilityPolicy: (name: string, cap: PluginCapability) => boolean;
  private readonly trustTierResolver: (pluginName: string) => PluginTrustTier;
  private readonly runtimeBus: RuntimeEventBusContract;

  /** Trust store — manages tier records for all plugins. */
  readonly trustStore: PluginTrustStore = new PluginTrustStore();
  /** Quarantine engine — tracks and applies quarantine constraints. */
  readonly quarantine: PluginQuarantineEngine = new PluginQuarantineEngine();

  constructor(options: PluginLifecycleManagerOptions = {}) {
    this.sessionId = options.sessionId ?? '';
    this.capabilityPolicy = options.capabilityPolicy ?? (() => true);
    this.trustTierResolver = options.trustTierResolver ?? ((name) => this.trustStore.getTier(name));
    this.runtimeBus = options.runtimeBus ?? new RuntimeEventBus();
  }

  // ── Plugin record accessors ────────────────────────────────────────────────

  /** Returns the lifecycle record for a plugin, or undefined if unknown. */
  getRecord(name: string): Readonly<PluginLifecycleRecord> | undefined {
    return this.records.get(name);
  }

  /** Returns all plugin lifecycle records as an array. */
  getAllRecords(): ReadonlyArray<Readonly<PluginLifecycleRecord>> {
    return Array.from(this.records.values());
  }

  /** Returns names of all plugins in a given state. */
  getPluginsInState(state: PluginLifecycleState): string[] {
    const result: string[] = [];
    for (const [name, record] of this.records) {
      if (record.state === state) result.push(name);
    }
    return result;
  }

  /** Returns names of all currently operational plugins (active or degraded). */
  getOperationalPlugins(): string[] {
    const result: string[] = [];
    for (const [name, record] of this.records) {
      if (isOperational(record.state)) result.push(name);
    }
    return result;
  }

  // ── Lifecycle operations ──────────────────────────────────────────────────

  /**
   * Register a discovered plugin. Creates its lifecycle record in the
   * `discovered` state and emits PLUGIN_DISCOVERED.
   */
  registerDiscovered(manifest: PluginManifestV2, pluginDir: string): void {
    const name = manifest.name;
    if (this.records.has(name)) {
      logger.debug(`[plugin-lifecycle] ${name}: already registered, skipping re-registration`);
      return;
    }

    const tier = this.trustTierResolver(name);
    const capabilities = resolveCapabilityManifest(name, manifest, this.capabilityPolicy, tier);

    const record: PluginLifecycleRecord = {
      name,
      version: manifest.version,
      state: 'discovered',
      capabilities,
      transitions: [],
      reloading: false,
      trustTier: tier,
      quarantined: this.quarantine.isQuarantined(name),
    };

    this.records.set(name, record);

    this.emit({
      type: 'PLUGIN_DISCOVERED',
      pluginId: name,
      path: pluginDir,
      version: manifest.version,
    });

    logger.debug(`[plugin-lifecycle] ${name}@${manifest.version}: registered (discovered)`);
  }

  /**
   * Load a plugin using the existing loader infrastructure.
   *
   * Transitions: discovered/disabled → loading → loaded → active
   * On failure:  loading → error
   */
  async loadPlugin(
    manifest: PluginManifestV2,
    pluginDir: string,
    deps: PluginLoaderDeps,
    cacheBust?: number,
  ): Promise<boolean> {
    const name = manifest.name;
    let record = this.records.get(name);

    if (!record) {
      this.registerDiscovered(manifest, pluginDir);
      record = this.records.get(name)!;
    }

    // discovered → loading (or disabled → loading for re-enable)
    const toLoadingResult = this.transition(name, 'loading');
    if (!toLoadingResult.ok) {
      logger.warn(`[plugin-lifecycle] ${name}: cannot start load — ${toLoadingResult.reason}`);
      return false;
    }

    this.emit({ type: 'PLUGIN_LOADING', pluginId: name, path: pluginDir });

    try {
      const loaded = await loadPlugin({ manifest, pluginDir }, deps, cacheBust);

      if (!loaded) {
        this.transition(name, 'error', 'loadPlugin returned null');
        this.updateRecord(name, { lastError: 'loadPlugin returned null', errorAt: Date.now() });
        this.emit({
          type: 'PLUGIN_ERROR',
          pluginId: name,
          error: 'loadPlugin returned null',
          fatal: false,
        });
        return false;
      }

      // loading → loaded
      this.transition(name, 'loaded');

      // loaded → active
      const toActiveResult = this.transition(name, 'active');
      if (!toActiveResult.ok) {
        logger.warn(`[plugin-lifecycle] ${name}: cannot transition to active — ${toActiveResult.reason}`);
        return false;
      }

      this.updateRecord(name, { activatedAt: Date.now() });

      this.emit({
        type: 'PLUGIN_LOADED',
        pluginId: name,
        version: manifest.version,
        capabilities: record.capabilities.granted as string[],
      });
      this.emit({ type: 'PLUGIN_ACTIVE', pluginId: name });

      logger.info(`[plugin-lifecycle] ${name}@${manifest.version}: active`);
      return true;
    } catch (err) {
      const errorMsg = summarizeError(err);
      this.transition(name, 'error', errorMsg);
      this.updateRecord(name, { lastError: errorMsg, errorAt: Date.now() });
      this.emit({
        type: 'PLUGIN_ERROR',
        pluginId: name,
        error: errorMsg,
        fatal: false,
      });
      logger.error(`[plugin-lifecycle] ${name}: load threw — ${errorMsg}`);
      return false;
    }
  }

  /**
   * Unload a plugin. Transitions active/loaded/degraded → unloading → disabled.
   */
  async unloadPlugin(
    name: string,
    reason?: string,
    loaderDeps?: { getLoadedPlugin?: (name: string) => LoadedPlugin | undefined },
  ): Promise<void> {
    const record = this.records.get(name);
    if (!record) {
      logger.debug(`[plugin-lifecycle] ${name}: unload requested but not tracked`);
      return;
    }

    const toUnloadingResult = this.transition(name, 'unloading', reason);
    if (!toUnloadingResult.ok) {
      logger.warn(`[plugin-lifecycle] ${name}: cannot unload — ${toUnloadingResult.reason}`);
      return;
    }

    this.emit({ type: 'PLUGIN_UNLOADING', pluginId: name, reason });

    // Delegate to the existing unloadPlugin function if a loaded instance is available.
    const loadedPlugin = loaderDeps?.getLoadedPlugin?.(name);
    if (loadedPlugin) {
      await unloadPlugin(loadedPlugin);
    }

    this.transition(name, 'disabled', reason);
    this.emit({
      type: 'PLUGIN_DISABLED',
      pluginId: name,
      reason: reason ?? 'unloaded',
    });

    logger.info(`[plugin-lifecycle] ${name}: disabled${reason ? ` (${reason})` : ''}`);
  }

  // ── Trust & Quarantine operations ────────────────────────────────────────

  /**
   * setTrustTier — Assign a trust tier to a plugin and re-sync the record.
   *
   * If the plugin has an active lifecycle record, the trust tier in the record
   * is updated immediately. Capability re-resolution requires a reload.
   */
  setTrustTier(name: string, tier: PluginTrustTier, note?: string): void {
    this.trustStore.setTier(name, tier, { note });
    const record = this.records.get(name);
    if (record) {
      record.trustTier = tier;
    }
    logger.info(`[plugin-lifecycle] ${name}: trust tier set to '${tier}'${note ? ` — ${note}` : ''}`);
  }

  /**
   * quarantinePlugin — Apply quarantine to a named plugin.
   *
   * Revokes high-risk capabilities from the live manifest and marks the record
   * as quarantined. Emits PLUGIN_DEGRADED to signal partial functionality.
   *
   * @returns true if quarantine was applied; false if not tracked or already quarantined.
   */
  quarantinePlugin(name: string, reason: string): boolean {
    const record = this.records.get(name);
    if (!record) {
      logger.warn(`[plugin-lifecycle] ${name}: quarantine requested but plugin not tracked`);
      return false;
    }

    const qRecord = this.quarantine.quarantine(name, record.capabilities, reason);
    if (!qRecord) return false;

    record.quarantined = true;

    this.emit({
      type: 'PLUGIN_DEGRADED',
      pluginId: name,
      reason: `quarantined: ${reason}`,
      affectedCapabilities: qRecord.revokedCapabilities as string[],
    });

    return true;
  }

  /**
   * liftQuarantine — Remove quarantine from a plugin.
   *
   * Capabilities are NOT restored here; the operator should reload the plugin
   * after lifting so that trust-aware re-resolution can grant capabilities
   * appropriate for the updated tier.
   *
   * @returns true if quarantine was lifted; false if no active quarantine.
   */
  liftQuarantine(name: string): boolean {
    const lifted = this.quarantine.lift(name);
    const record = this.records.get(name);
    if (record) {
      record.quarantined = false;
    }
    if (lifted) {
      logger.info(`[plugin-lifecycle] ${name}: quarantine lifted — reload to restore capabilities`);
    }
    return lifted;
  }

  /**
   * Mark a plugin as degraded (partial functionality). Only valid from active.
   */
  degradePlugin(name: string, reason: string, affectedCapabilities: string[] = []): void {
    const record = this.records.get(name);
    if (!record) return;

    const result = this.transition(name, 'degraded', reason);
    if (!result.ok) {
      logger.warn(`[plugin-lifecycle] ${name}: cannot degrade — ${result.reason}`);
      return;
    }

    this.emit({
      type: 'PLUGIN_DEGRADED',
      pluginId: name,
      reason,
      affectedCapabilities,
    });

    logger.warn(`[plugin-lifecycle] ${name}: degraded — ${reason}`);
  }

  /**
   * Record a non-fatal error without transitioning state.
   * If the plugin is active, it may optionally be moved to degraded.
   */
  recordError(name: string, error: string, fatal: boolean): void {
    const record = this.records.get(name);
    if (!record) return;

    this.updateRecord(name, { lastError: error, errorAt: Date.now() });
    this.emit({ type: 'PLUGIN_ERROR', pluginId: name, error, fatal });

    if (fatal && (record.state === 'active' || record.state === 'loaded' || record.state === 'degraded')) {
      this.transition(name, 'error', error);
    }

    logger.error(`[plugin-lifecycle] ${name}: error (fatal=${String(fatal)}) — ${error}`);
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  /**
   * Scan for plugins and register newly discovered ones.
   * Existing records are not modified.
   */
  scanAndRegister(pathOptions: PluginPathOptions): void {
    const discovered = discoverPlugins(pathOptions);
    for (const { manifest, pluginDir } of discovered) {
      if (!this.records.has(manifest.name)) {
        this.registerDiscovered(manifest as PluginManifestV2, pluginDir);
      }
    }
    logger.debug(`[plugin-lifecycle] Scan complete: ${discovered.length} plugin(s) found`);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Apply a state machine transition for a named plugin.
   * Records the transition in the plugin's history.
   * Returns the TransitionResult from the state machine.
   */
  private transition(
    name: string,
    to: PluginLifecycleState,
    reason?: string,
  ): { ok: boolean; reason?: string } {
    const record = this.records.get(name);
    if (!record) return { ok: false, reason: `Plugin '${name}' not tracked` };

    const result = applyTransition(record.state, to);
    if (!result.ok) return result;

    const entry: PluginTransition = {
      pluginName: name,
      from: result.from,
      to: result.to,
      ts: Date.now(),
      reason,
    };

    // Mutate the record in place — the record lives inside the Map.
    record.transitions.push(entry);
    if (record.transitions.length > MAX_TRANSITION_HISTORY) {
      record.transitions.shift();
    }
    record.state = to;

    logger.debug(`[plugin-lifecycle] ${name}: ${result.from} → ${to}${reason ? ` (${reason})` : ''}`);
    return { ok: true };
  }

  /**
   * Partially update a plugin record's mutable fields.
   */
  private updateRecord(
    name: string,
    patch: Partial<Pick<PluginLifecycleRecord, 'lastError' | 'errorAt' | 'activatedAt' | 'reloading' | 'trustTier' | 'quarantined'>>,
  ): void {
    const record = this.records.get(name);
    if (!record) return;
    if (patch.lastError !== undefined) record.lastError = patch.lastError;
    if (patch.errorAt !== undefined) record.errorAt = patch.errorAt;
    if (patch.activatedAt !== undefined) record.activatedAt = patch.activatedAt;
    if (patch.reloading !== undefined) record.reloading = patch.reloading;
  }

  private emit(event: PluginEvent): void {
    const ctx = {
      sessionId: this.sessionId,
      traceId: `plugin-lifecycle:${event.pluginId}`,
      source: EVENT_SOURCE,
    } as const;
    try {
      switch (event.type) {
        case 'PLUGIN_DISCOVERED':
          emitPluginDiscovered(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_LOADING':
          emitPluginLoading(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_LOADED':
          emitPluginLoaded(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_ACTIVE':
          emitPluginActive(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_DEGRADED':
          emitPluginDegraded(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_ERROR':
          emitPluginError(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_UNLOADING':
          emitPluginUnloading(this.runtimeBus, ctx, event);
          break;
        case 'PLUGIN_DISABLED':
          emitPluginDisabled(this.runtimeBus, ctx, event);
          break;
      }
    } catch (err) {
      logger.debug(`[plugin-lifecycle] runtime emit failed: ${summarizeError(err)}`);
    }
  }
}
