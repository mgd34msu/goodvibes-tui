/**
 * PluginLifecycleManager — v3 §4.6 + §9.
 *
 * Tracks all plugins through the 8-state lifecycle machine, resolves capability
 * manifests on load, and emits PluginEvents at every state transition.
 *
 * Gated by the `plugin-lifecycle-v2` feature flag.
 */

import { logger } from '../../utils/logger.ts';
import type { EventBus } from '../../core/event-bus.ts';
import type { PluginEvent } from '../events/plugins.ts';
import type { PluginLoaderDeps, LoadedPlugin } from '../../plugins/loader.ts';
import {
  discoverPlugins,
  loadPlugin,
  unloadPlugin,
} from '../../plugins/loader.ts';
import type { PluginLifecycleState } from '../store/domains/plugins.ts';
import {
  type PluginCapability,
  type PluginLifecycleManagerOptions,
  type PluginLifecycleRecord,
  type PluginManifestV2,
  type PluginTransition,
  MAX_TRANSITION_HISTORY,
} from './types.ts';
import { applyTransition, isOperational } from './lifecycle.ts';
import { resolveCapabilityManifest } from './manifest.ts';

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
  private eventBus: EventBus | undefined;

  constructor(options: PluginLifecycleManagerOptions = {}) {
    this.sessionId = options.sessionId ?? '';
    this.capabilityPolicy = options.capabilityPolicy ?? (() => true);
  }

  /**
   * Attach an EventBus to receive PluginEvents on state transitions.
   * Optional — manager works without an event bus (no events emitted).
   */
  attachEventBus(bus: EventBus): void {
    this.eventBus = bus;
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

    const capabilities = resolveCapabilityManifest(name, manifest, this.capabilityPolicy);

    const record: PluginLifecycleRecord = {
      name,
      version: manifest.version,
      state: 'discovered',
      capabilities,
      transitions: [],
      reloading: false,
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
      const errorMsg = String(err);
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
  scanAndRegister(): void {
    const discovered = discoverPlugins();
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
    patch: Partial<Pick<PluginLifecycleRecord, 'lastError' | 'errorAt' | 'activatedAt' | 'reloading'>>,
  ): void {
    const record = this.records.get(name);
    if (!record) return;
    if (patch.lastError !== undefined) record.lastError = patch.lastError;
    if (patch.errorAt !== undefined) record.errorAt = patch.errorAt;
    if (patch.activatedAt !== undefined) record.activatedAt = patch.activatedAt;
    if (patch.reloading !== undefined) record.reloading = patch.reloading;
  }

  /**
   * Emit a PluginEvent via the attached EventBus (if any).
   * The EventBus.emit signature accepts a string event name and payload.
   */
  private emit(event: PluginEvent): void {
    if (!this.eventBus) return;
    try {
      // EventBus.emit(eventName, payload) — cast as unknown to avoid EventMap constraint.
      (this.eventBus as { emit(name: string, data: unknown): void }).emit(event.type, event);
    } catch (err) {
      // Non-fatal — event emission failures must not break plugin management.
      logger.debug(`[plugin-lifecycle] EventBus emit failed: ${String(err)}`);
    }
  }
}
