/**
 * PluginEvent — discriminated union covering all plugin lifecycle events.
 *
 * Covers plugin lifecycle events for the runtime event bus.
 */

export type PluginEvent =
  /** Plugin has been found during discovery scan. */
  | { type: 'PLUGIN_DISCOVERED'; pluginId: string; path: string; version: string }
  /** Plugin is being loaded and initialised. */
  | { type: 'PLUGIN_LOADING'; pluginId: string; path: string }
  /** Plugin has been successfully loaded. */
  | { type: 'PLUGIN_LOADED'; pluginId: string; version: string; capabilities: string[] }
  /** Plugin is fully active and serving requests. */
  | { type: 'PLUGIN_ACTIVE'; pluginId: string }
  /** Plugin is running in degraded mode (partial functionality). */
  | { type: 'PLUGIN_DEGRADED'; pluginId: string; reason: string; affectedCapabilities: string[] }
  /** Plugin encountered a non-fatal error. */
  | { type: 'PLUGIN_ERROR'; pluginId: string; error: string; fatal: boolean }
  /** Plugin is being unloaded and cleaned up. */
  | { type: 'PLUGIN_UNLOADING'; pluginId: string; reason?: string }
  /** Plugin has been disabled (will not reload on restart). */
  | { type: 'PLUGIN_DISABLED'; pluginId: string; reason: string };

/** All plugin event type literals as a union. */
export type PluginEventType = PluginEvent['type'];
