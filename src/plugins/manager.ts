import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.ts';
import {
  discoverPlugins,
  loadPlugin,
  unloadPlugin,
  PLUGINS_DIR,
  type LoadedPlugin,
  type PluginLoaderDeps,
} from './loader.ts';

/** Path to the plugin state persistence file. */
const PLUGINS_STATE_FILE = join(homedir(), '.goodvibes', 'tui', 'plugins.json');

/**
 * PluginState — Persisted state for all plugins.
 */
interface PluginState {
  /** Map of plugin name → enabled boolean. */
  enabled: Record<string, boolean>;
  /** Map of plugin name → plugin-specific config. */
  config: Record<string, Record<string, unknown>>;
}

/**
 * PluginStatus — Public-facing plugin info for /plugin list.
 */
export interface PluginStatus {
  name: string;
  version: string;
  description: string;
  author?: string;
  enabled: boolean;
  active: boolean;
}

const DEFAULT_STATE: PluginState = { enabled: {}, config: {} };

/**
 * PluginManager — Singleton that orchestrates plugin discovery, loading, and persistence.
 */
export class PluginManager {
  private static _instance: PluginManager | undefined;

  private plugins = new Map<string, LoadedPlugin>();
  private state: PluginState = { ...DEFAULT_STATE, enabled: {}, config: {} };
  private deps: PluginLoaderDeps | undefined;

  private constructor() {}

  static getInstance(): PluginManager {
    if (!PluginManager._instance) {
      PluginManager._instance = new PluginManager();
    }
    return PluginManager._instance;
  }

  /**
   * init — Must be called once at startup with application dependencies.
   * Loads state from disk, then discovers and loads all enabled plugins.
   */
  async init(deps: PluginLoaderDeps): Promise<void> {
    this.deps = deps;
    this.loadState();
    await this.loadEnabledPlugins();
  }

  /** Returns status for all discovered plugins (enabled or not). */
  list(): PluginStatus[] {
    const discovered = discoverPlugins();
    return discovered.map((d) => {
      const loaded = this.plugins.get(d.manifest.name);
      return {
        name: d.manifest.name,
        version: d.manifest.version,
        description: d.manifest.description,
        author: d.manifest.author,
        enabled: this.isEnabled(d.manifest.name),
        active: loaded?.active ?? false,
      };
    });
  }

  /** Enable a plugin by name. Loads it immediately if deps are available. */
  async enable(name: string): Promise<{ ok: boolean; error?: string }> {
    if (this.isEnabled(name)) {
      return { ok: false, error: `Plugin '${name}' is already enabled` };
    }

    const discovered = discoverPlugins().find((d) => d.manifest.name === name);
    if (!discovered) {
      return { ok: false, error: `Plugin '${name}' not found in ${PLUGINS_DIR}` };
    }

    this.state.enabled[name] = true;
    this.saveState();

    if (this.deps) {
      const loaded = await loadPlugin(discovered, this.deps);
      if (loaded) {
        this.plugins.set(name, loaded);
      } else {
        // Revert enable on load failure
        delete this.state.enabled[name];
        this.saveState();
        return { ok: false, error: `Plugin '${name}' failed to load — check logs` };
      }
    }

    return { ok: true };
  }

  /** Disable a plugin by name. Deactivates it immediately if active. */
  async disable(name: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isEnabled(name)) {
      return { ok: false, error: `Plugin '${name}' is not enabled` };
    }

    const loaded = this.plugins.get(name);
    if (loaded) {
      await unloadPlugin(loaded);
      this.plugins.delete(name);
    }

    delete this.state.enabled[name];
    this.saveState();
    return { ok: true };
  }

  /** Reload all currently enabled plugins (deactivate then reactivate). */
  async reload(): Promise<{ reloaded: number; failed: number }> {
    const names = Object.keys(this.state.enabled).filter((n) => this.state.enabled[n]);
    let reloaded = 0;
    let failed = 0;

    // Deactivate all
    for (const name of names) {
      const loaded = this.plugins.get(name);
      if (loaded) {
        await unloadPlugin(loaded);
        this.plugins.delete(name);
      }
    }

    // Reactivate with cache busting — append timestamp to force fresh import
    if (this.deps) {
      const discovered = discoverPlugins();
      const cacheBust = Date.now();
      for (const d of discovered) {
        if (!this.isEnabled(d.manifest.name)) continue;
        // Pass cacheBust so loadPlugin appends ?t=<timestamp> to the import URL,
        // forcing Bun to bypass its module cache and re-execute the file.
        const loaded = await loadPlugin(d, this.deps, cacheBust);
        if (loaded) {
          this.plugins.set(d.manifest.name, loaded);
          reloaded++;
        } else {
          failed++;
        }
      }
    }

    return { reloaded, failed };
  }

  /** Returns whether a plugin is marked as enabled in persisted state. */
  isEnabled(name: string): boolean {
    return this.state.enabled[name] === true;
  }

  /** Returns plugin-specific config for a given plugin name. */
  getPluginConfig(name: string): Record<string, unknown> {
    return this.state.config[name] ?? {};
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async loadEnabledPlugins(): Promise<void> {
    if (!this.deps) return;
    const discovered = discoverPlugins();
    for (const d of discovered) {
      if (!this.isEnabled(d.manifest.name)) continue;
      const loaded = await loadPlugin(d, this.deps);
      if (loaded) {
        this.plugins.set(d.manifest.name, loaded);
      }
    }
  }

  private loadState(): void {
    try {
      if (existsSync(PLUGINS_STATE_FILE)) {
        const raw = readFileSync(PLUGINS_STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PluginState>;
        this.state.enabled = parsed.enabled ?? {};
        this.state.config = parsed.config ?? {};
      }
    } catch (err) {
      logger.warn(`[plugins] Could not load state: ${String(err)}`);
    }
  }

  private saveState(): void {
    try {
      mkdirSync(join(homedir(), '.goodvibes', 'tui'), { recursive: true });
      writeFileSync(PLUGINS_STATE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`[plugins] Could not save state: ${String(err)}`);
    }
  }

}

/** Module-level singleton accessor. */
export const pluginManager = PluginManager.getInstance();
