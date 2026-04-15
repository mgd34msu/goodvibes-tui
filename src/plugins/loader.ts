import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { createPluginAPI, type PluginAPIContext } from './api';
import type { CommandRegistry } from '../input/command-registry.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { ChannelDeliveryRouter, ChannelPluginRegistry } from '@pellux/goodvibes-sdk/platform/channels/index';
import type { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state/index';
import type { VoiceProviderRegistry } from '@pellux/goodvibes-sdk/platform/voice/index';
import type { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media/index';
import type { WebSearchProviderRegistry } from '@pellux/goodvibes-sdk/platform/web-search/index';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export interface PluginPathOptions {
  readonly cwd: string;
  readonly homeDir: string;
}

/**
 * Plugin search directories in precedence order.
 * Project-local plugins override global plugins with the same manifest name.
 */
export function getUserPluginDirectory(options: PluginPathOptions): string {
  return join(options.homeDir, '.goodvibes', 'tui', 'plugins');
}

export function getPluginDirectories(options: PluginPathOptions): string[] {
  return [
    join(options.cwd, '.goodvibes', 'plugins'),
    join(options.cwd, '.goodvibes', 'tui', 'plugins'),
    getUserPluginDirectory(options),
  ];
}

/**
 * PluginManifest — The structure of a plugin's manifest.json.
 */
export interface PluginManifest {
  /** Unique plugin identifier (no spaces, lowercase-kebab). */
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Entry point relative to plugin directory. Defaults to "index.ts". */
  main?: string;
  /** Optional list of runtime event names the plugin subscribes to. */
  hooks?: string[];
}

/**
 * PluginEntryPoint — The exports expected from a plugin's entry file.
 */
export interface PluginEntryPoint {
  /** Called once after the plugin is loaded. Receives the sandboxed PluginAPI. */
  init(api: ReturnType<typeof createPluginAPI>): void | Promise<void>;
  /** Optional: called when the plugin is activated (after init). */
  activate?(): void | Promise<void>;
  /** Optional: called when the plugin is deactivated (before cleanup). */
  deactivate?(): void | Promise<void>;
}

/**
 * LoadedPlugin — Runtime state of a single loaded plugin.
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute path to the plugin directory. */
  pluginDir: string;
  /** Whether the plugin is currently active (init + activate completed). */
  active: boolean;
  /** Cleanup callbacks accumulated during plugin API use. */
  cleanup: Array<() => void>;
  /** The resolved entry point module (available after load). */
  entry?: PluginEntryPoint;
}

/**
 * DiscoveredPlugin — Result of scanning the plugins directory.
 */
export interface DiscoveredPlugin {
  pluginDir: string;
  manifest: PluginManifest;
}

/**
 * discoverPlugins — Scan the configured plugin directories for valid plugin folders.
 * Each subdirectory with a readable manifest.json is a candidate.
 */
function scanPluginDirectory(rootDir: string): DiscoveredPlugin[] {
  if (!existsSync(rootDir)) return [];
  const results: DiscoveredPlugin[] = [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch (err) {
    logger.warn(`[plugins] Could not read plugins directory '${rootDir}': ${summarizeError(err)}`);
    return [];
  }

  for (const entry of entries) {
    const pluginDir = join(rootDir, entry);
    try {
      if (!statSync(pluginDir).isDirectory()) continue;

      const manifestPath = join(pluginDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      const raw = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as PluginManifest;

      if (!manifest.name || !manifest.version) {
        logger.warn(`[plugins] ${entry}: manifest.json missing required fields (name, version)`);
        continue;
      }

      // Validate manifest field types
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
        logger.warn(`[plugins] ${entry}: manifest.json 'name' and 'version' must be strings`);
        continue;
      }
      if (manifest.main !== undefined) {
        if (typeof manifest.main !== 'string') {
          logger.warn(`[plugins] ${entry}: manifest.json 'main' must be a string`);
          continue;
        }
        if (isAbsolute(manifest.main)) {
          logger.warn(`[plugins] ${entry}: manifest.json 'main' must be a relative path, not absolute`);
          continue;
        }
      }

      results.push({ pluginDir, manifest });
    } catch (err) {
      logger.warn(`[plugins] ${entry}: failed to parse manifest — ${summarizeError(err)}`);
    }
  }

  return results;
}

export function discoverPlugins(options: PluginPathOptions): DiscoveredPlugin[] {
  const discovered = new Map<string, DiscoveredPlugin>();
  for (const dir of getPluginDirectories(options)) {
    for (const plugin of scanPluginDirectory(dir)) {
      if (!discovered.has(plugin.manifest.name)) {
        discovered.set(plugin.manifest.name, plugin);
      }
    }
  }
  return [...discovered.values()];
}

/**
 * PluginLoaderDeps — External dependencies injected into the loader.
 */
export interface PluginLoaderDeps {
  runtimeBus: RuntimeEventBus;
  commandRegistry: CommandRegistry;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  gatewayMethods: GatewayMethodCatalog;
  channelRegistry: ChannelPluginRegistry;
  channelDeliveryRouter: ChannelDeliveryRouter;
  memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  voiceProviderRegistry: VoiceProviderRegistry;
  mediaProviderRegistry: MediaProviderRegistry;
  webSearchProviderRegistry: WebSearchProviderRegistry;
  /** Returns plugin-specific config given a plugin name. */
  getPluginConfig(name: string): Record<string, unknown>;
  /** Returns whether a plugin is enabled in persistent state. */
  isEnabled(name: string): boolean;
}

/**
 * loadPlugin — Load, init, and activate a single plugin.
 * Returns a LoadedPlugin on success, or null on failure.
 *
 * @param cacheBust - Optional timestamp suffix appended to the import URL to bypass
 *   Bun's module cache. Pass `Date.now()` on reload to force fresh execution.
 */
export async function loadPlugin(
  discovered: DiscoveredPlugin,
  deps: PluginLoaderDeps,
  cacheBust?: number,
): Promise<LoadedPlugin | null> {
  const { manifest, pluginDir } = discovered;
  const entryFile = manifest.main ?? 'index.ts';
  const entryPath = join(pluginDir, entryFile);

  // Path traversal guard: resolved entry must remain within pluginDir
  const resolvedEntry = resolve(entryPath);
  const resolvedPluginDir = resolve(pluginDir);
  if (!resolvedEntry.startsWith(resolvedPluginDir + '/') && resolvedEntry !== resolvedPluginDir) {
    logger.error(`[plugins] ${manifest.name}: path traversal detected — entry '${entryFile}' resolves outside plugin directory`);
    return null;
  }

  if (!existsSync(entryPath)) {
    logger.warn(`[plugins] ${manifest.name}: entry file not found: ${entryPath}`);
    return null;
  }

  // Trust notice — plugins run as trusted code (like VS Code extensions)
  logger.warn(`[plugins] Loading '${manifest.name}' — plugins are trusted code and run with full application access`);

  const loaded: LoadedPlugin = {
    manifest,
    pluginDir,
    active: false,
    cleanup: [],
  };

  try {
    // Dynamic import — Bun supports TS imports directly.
    // Append cache-bust query param on reload so Bun re-executes the module.
    const importPath = cacheBust !== undefined ? `${entryPath}?t=${cacheBust}` : entryPath;
    const mod = await import(importPath) as unknown;

    // Validate module shape before casting
    if (!mod || typeof mod !== 'object') {
      logger.warn(`[plugins] ${manifest.name}: entry file did not export a module object`);
      return null;
    }
    const modObj = mod as Record<string, unknown>;
    if (typeof modObj['init'] !== 'function') {
      logger.warn(`[plugins] ${manifest.name}: entry file must export an init() function`);
      return null;
    }
    if (modObj['activate'] !== undefined && typeof modObj['activate'] !== 'function') {
      logger.warn(`[plugins] ${manifest.name}: entry file 'activate' export must be a function`);
      return null;
    }
    if (modObj['deactivate'] !== undefined && typeof modObj['deactivate'] !== 'function') {
      logger.warn(`[plugins] ${manifest.name}: entry file 'deactivate' export must be a function`);
      return null;
    }
    const entry = mod as PluginEntryPoint;

    loaded.entry = entry;

    const ctx: PluginAPIContext = {
      pluginName: manifest.name,
      runtimeBus: deps.runtimeBus,
      commandRegistry: deps.commandRegistry,
      providerRegistry: deps.providerRegistry,
      toolRegistry: deps.toolRegistry,
      gatewayMethods: deps.gatewayMethods,
      channelRegistry: deps.channelRegistry,
      channelDeliveryRouter: deps.channelDeliveryRouter,
      memoryEmbeddingRegistry: deps.memoryEmbeddingRegistry,
      voiceProviderRegistry: deps.voiceProviderRegistry,
      mediaProviderRegistry: deps.mediaProviderRegistry,
      webSearchProviderRegistry: deps.webSearchProviderRegistry,
      pluginConfig: deps.getPluginConfig(manifest.name),
      cleanup: loaded.cleanup,
    };

    const api = createPluginAPI(ctx);

    // Lifecycle: init
    await entry.init(api);

    // Lifecycle: activate
    if (typeof entry.activate === 'function') {
      await entry.activate();
    }

    loaded.active = true;
    logger.info(`[plugins] ${manifest.name} v${manifest.version} activated`);
    return loaded;
  } catch (err) {
    logger.error(`[plugins] ${manifest.name}: load failed — ${summarizeError(err)}`);
    // Run cleanup for anything that was registered before the error
    for (const fn of loaded.cleanup) {
      try { fn(); } catch { /* best-effort */ }
    }
    return null;
  }
}

/**
 * unloadPlugin — Deactivate a plugin and run all cleanup callbacks.
 */
export async function unloadPlugin(plugin: LoadedPlugin): Promise<void> {
  if (!plugin.active) return;

  try {
    if (typeof plugin.entry?.deactivate === 'function') {
      await plugin.entry.deactivate();
    }
  } catch (err) {
    logger.warn(`[plugins] ${plugin.manifest.name}: deactivate threw — ${summarizeError(err)}`);
  }

  for (const fn of plugin.cleanup) {
    try { fn(); } catch { /* best-effort */ }
  }
  plugin.cleanup.length = 0;
  plugin.active = false;
  logger.info(`[plugins] ${plugin.manifest.name} deactivated`);
}
