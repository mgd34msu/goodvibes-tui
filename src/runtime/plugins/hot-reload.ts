/**
 * Safe hot-reload protocol for plugins.
 *
 * Implements the 6-phase hot-reload sequence:
 *   1. Quiesce   — stop accepting new work from the plugin
 *   2. Unregister — remove plugin's registrations (commands, tools, hooks)
 *   3. Unload    — deactivate and clean up the old plugin instance
 *   4. Reload    — load the new version with a cache-bust timestamp
 *   5. Re-register — new instance calls init/activate (registers naturally)
 *   6. Health check → active (healthy) or degraded (unhealthy)
 */

import { logger } from '../../utils/logger.ts';
import type { PluginLoaderDeps } from '../../plugins/loader.ts';
import type { LoadedPlugin } from '../../plugins/loader.ts';
import type { PluginHealthCheckResult, PluginManifestV2 } from './types.ts';
import type { PluginLifecycleManager } from './manager.ts';
import { summarizeError } from '../../utils/error-display.ts';

/**
 * Options for a single plugin hot-reload operation.
 */
export interface HotReloadOptions {
  /**
   * Callback to retrieve the current loaded plugin instance by name.
   * Used to call deactivate() and run cleanup before unloading.
   */
  getLoadedPlugin: (name: string) => LoadedPlugin | undefined;

  /**
   * Callback to remove a plugin's loaded instance from the host's registry.
   * Called after unload to clean up the host-side reference.
   */
  removeLoadedPlugin: (name: string) => void;

  /**
   * Callback to store the newly loaded plugin instance in the host's registry.
   * Called after a successful reload.
   */
  storeLoadedPlugin: (name: string, plugin: LoadedPlugin) => void;

  /**
   * Optional health check callback invoked after re-registration.
   * Return a PluginHealthCheckResult to indicate whether the plugin is healthy.
   * Defaults to a trivial healthy check.
   */
  healthCheck?: (name: string) => Promise<PluginHealthCheckResult>;

  /**
   * Maximum time (ms) to wait for the health check before timing out.
   * Defaults to 5000ms.
   */
  healthCheckTimeoutMs?: number;
}

/**
 * Result of a hot-reload operation.
 */
export interface HotReloadResult {
  /** Whether the reload completed successfully and the plugin is healthy. */
  success: boolean;
  /** Phase that failed (if success === false). */
  failedPhase?: 'quiesce' | 'unregister' | 'unload' | 'reload' | 're-register' | 'health-check';
  /** Error message (if success === false). */
  error?: string;
  /** Duration of the reload in milliseconds. */
  durationMs: number;
  /** Whether the plugin ended in degraded state (partial success). */
  degraded: boolean;
}

/** Default trivial health check — always returns healthy. */
async function defaultHealthCheck(name: string): Promise<PluginHealthCheckResult> {
  return {
    healthy: true,
    message: `${name}: health check passed (default)`,
    durationMs: 0,
  };
}

/**
 * runHotReload — Execute the safe 6-phase hot-reload protocol for a single
 * plugin.
 *
 * @param name      - Plugin name.
 * @param manifest  - Current manifest for the plugin.
 * @param pluginDir - Absolute path to the plugin directory.
 * @param deps      - Loader dependencies (runtime bus, registries, etc.).
 * @param lcm       - PluginLifecycleManager to track state transitions.
 * @param options   - Host-side callbacks and configuration.
 * @returns HotReloadResult describing the outcome.
 */
export async function runHotReload(
  name: string,
  manifest: PluginManifestV2,
  pluginDir: string,
  deps: PluginLoaderDeps,
  lcm: PluginLifecycleManager,
  options: HotReloadOptions,
): Promise<HotReloadResult> {
  const startTs = Date.now();
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const timeoutMs = options.healthCheckTimeoutMs ?? 5000;

  const record = lcm.getRecord(name);
  if (!record) {
    return {
      success: false,
      failedPhase: 'quiesce',
      error: `Plugin '${name}' is not tracked by the lifecycle manager`,
      durationMs: Date.now() - startTs,
      degraded: false,
    };
  }

  logger.info(`[plugin-hot-reload] ${name}: starting hot-reload`);

  // ── Phase 1: Quiesce ────────────────────────────────────────────────────
  // Mark the plugin as reloading to signal to callers to defer new work.
  // (The PluginLifecycleRecord.reloading flag is set, but state is not changed.)
  // In a future implementation this phase could drain in-flight requests.
  try {
    // Access via cast since reloading is a mutable field on the record.
    const mutableRecord = record as { reloading: boolean };
    mutableRecord.reloading = true;
    logger.debug(`[plugin-hot-reload] ${name}: phase 1/6 quiesced`);
  } catch (err) {
    return failure('quiesce', summarizeError(err), startTs);
  }

  // ── Phase 2: Prepare unregister ──────────────────────────────────────────
  // The existing plugin's cleanup callbacks handle un-registration during
  // unload, so there is no separate hook dispatch here.
  logger.debug(`[plugin-hot-reload] ${name}: phase 2/6 unregister scheduled with unload cleanup`);

  // ── Phase 3: Unload ─────────────────────────────────────────────────────
  try {
    const loaded = options.getLoadedPlugin(name);
    if (loaded) {
      const { unloadPlugin } = await import('../../plugins/loader.ts');
      await unloadPlugin(loaded);
    }
    options.removeLoadedPlugin(name);
    logger.debug(`[plugin-hot-reload] ${name}: phase 3/6 unloaded`);
  } catch (err) {
    return failure('unload', summarizeError(err), startTs);
  }

  // ── Phase 4 + 5: Reload + Re-register ──────────────────────────────────
  // loadPlugin calls init() and activate() which re-registers everything.
  let reloadedPlugin: import('../../plugins/loader.ts').LoadedPlugin | null = null;
  try {
    const { loadPlugin } = await import('../../plugins/loader.ts');
    const cacheBust = Date.now();
    reloadedPlugin = await loadPlugin({ manifest, pluginDir }, deps, cacheBust);
    if (!reloadedPlugin) {
      return failure('reload', 'loadPlugin returned null', startTs);
    }
    options.storeLoadedPlugin(name, reloadedPlugin);
    logger.debug(`[plugin-hot-reload] ${name}: phases 4+5/6 reloaded + re-registered`);
  } catch (err) {
    return failure('reload', summarizeError(err), startTs);
  }

  // ── Phase 6: Health check ────────────────────────────────────────────────
  let healthResult: PluginHealthCheckResult;
  try {
    healthResult = await Promise.race([
      healthCheck(name),
      new Promise<PluginHealthCheckResult>((_, reject) =>
        setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  } catch (err) {
    healthResult = {
      healthy: false,
      message: summarizeError(err),
      durationMs: Date.now() - startTs,
    };
  }

  // Clear reloading flag.
  try {
    const mutableRecord = lcm.getRecord(name) as { reloading: boolean } | undefined;
    if (mutableRecord) mutableRecord.reloading = false;
  } catch { /* non-fatal */ }

  if (healthResult.healthy) {
    logger.info(`[plugin-hot-reload] ${name}: hot-reload complete — active (${Date.now() - startTs}ms)`);
    return {
      success: true,
      durationMs: Date.now() - startTs,
      degraded: false,
    };
  } else {
    // Plugin loaded but health check failed → degraded.
    lcm.degradePlugin(name, `Health check failed: ${healthResult.message}`);
    logger.warn(`[plugin-hot-reload] ${name}: hot-reload complete — degraded (${healthResult.message})`);
    return {
      success: true, // reload succeeded; just in degraded state
      durationMs: Date.now() - startTs,
      degraded: true,
    };
  }
}

/** Build a failure result for a named phase. */
function failure(
  phase: HotReloadResult['failedPhase'],
  error: string,
  startTs: number,
): HotReloadResult {
  logger.error(`[plugin-hot-reload] phase '${String(phase)}' failed: ${error}`);
  return {
    success: false,
    failedPhase: phase,
    error,
    durationMs: Date.now() - startTs,
    degraded: false,
  };
}
