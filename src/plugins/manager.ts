import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.ts';
import {
  discoverPlugins,
  getPluginDirectories,
  loadPlugin,
  unloadPlugin,
  type LoadedPlugin,
  type PluginLoaderDeps,
  type PluginPathOptions,
} from './loader.ts';
import {
  PluginTrustStore,
  type PluginTrustTier,
  type PluginTrustRecord,
  type SignatureValidationResult,
} from '../runtime/plugins/trust.ts';
import { PluginQuarantineEngine, type QuarantineRecord } from '../runtime/plugins/quarantine.ts';
import { isHighRiskCapability, resolveCapabilityManifest } from '../runtime/plugins/manifest.ts';
import type { PluginCapability, PluginManifestV2 } from '../runtime/plugins/types.ts';

/**
 * PluginState — Persisted state for all plugins.
 */
interface PluginState {
  /** Map of plugin name → enabled boolean. */
  enabled: Record<string, boolean>;
  /** Map of plugin name → plugin-specific config. */
  config: Record<string, Record<string, unknown>>;
  /** Map of plugin name → trust record. */
  trust: Record<string, PluginTrustRecord>;
  /** Map of plugin name → quarantine record. */
  quarantine: Record<string, QuarantineRecord>;
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
  /** Trust tier for this plugin. */
  trustTier: PluginTrustTier;
  /** Whether this plugin is currently quarantined. */
  quarantined: boolean;
}

export interface PluginManagerObserver {
  subscribe(callback: () => void): () => void;
  list(): PluginStatus[];
  capabilities(name: string): {
    ok: boolean;
    error?: string;
    requested: string[];
    highRisk: string[];
    safe: string[];
    tier: PluginTrustTier;
    blocked: string[];
  } | null;
  getTrustRecord(name: string): Readonly<PluginTrustRecord> | undefined;
  getQuarantineRecord(name: string): Readonly<QuarantineRecord> | undefined;
}

const DEFAULT_STATE: PluginState = { enabled: {}, config: {}, trust: {}, quarantine: {} };

export interface PluginManagerOptions {
  readonly pathOptions: PluginPathOptions;
  readonly stateFilePath?: string;
}

/**
 * PluginManager — orchestrates plugin discovery, loading, and persistence.
 */
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private state: PluginState = { ...DEFAULT_STATE, enabled: {}, config: {}, trust: {}, quarantine: {} };
  private deps: PluginLoaderDeps | undefined;

  /** Trust store — manages tier records for all plugins. */
  private readonly trustStore = new PluginTrustStore();
  /** Quarantine engine — manages plugin quarantine state. */
  private readonly quarantineEngine = new PluginQuarantineEngine();
  private readonly subscribers = new Set<() => void>();
  private readonly pathOptions: PluginPathOptions;
  private readonly stateFilePath: string;

  constructor(options: PluginManagerOptions) {
    this.pathOptions = options.pathOptions;
    this.stateFilePath = options.stateFilePath
      ?? join(options.pathOptions.homeDir, '.goodvibes', 'tui', 'plugins.json');
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
    const discovered = this.discoverPlugins();
    return discovered.map((d) => {
      const loaded = this.plugins.get(d.manifest.name);
      return {
        name: d.manifest.name,
        version: d.manifest.version,
        description: d.manifest.description,
        author: d.manifest.author,
        enabled: this.isEnabled(d.manifest.name),
        active: loaded?.active ?? false,
        trustTier: this.trustStore.getTier(d.manifest.name),
        quarantined: this.quarantineEngine.isQuarantined(d.manifest.name),
      };
    });
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getTrustRecord(name: string): Readonly<PluginTrustRecord> | undefined {
    return this.trustStore.getRecord(name);
  }

  getQuarantineRecord(name: string): Readonly<QuarantineRecord> | undefined {
    return this.quarantineEngine.getRecord(name);
  }

  /**
   * trust — Set the trust tier for a plugin.
   *
   * For the `trusted` tier, prefer `trustSigned()` which also validates the
   * signature. This method is for operator-forced tier assignment.
   */
  trust(
    name: string,
    tier: PluginTrustTier,
    note?: string,
  ): { ok: boolean; error?: string } {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    // Warn if trying to manually set 'trusted' without a signed manifest.
    if (tier === 'trusted') {
      const manifest = discovered.manifest as { signature?: string };
      if (!manifest.signature) {
        logger.warn(
          `[plugins] '${name}' set to 'trusted' tier without a signed manifest — ` +
          'consider using /plugin verify first',
        );
      }
    }

    const record = this.trustStore.setTier(name, tier, { note });
    this.state.trust[name] = record;
    this.saveState();
    logger.info(`[plugins] ${name}: trust tier set to '${tier}'`);
    this.notifySubscribers();
    return { ok: true };
  }

  /**
   * trustSigned — Elevate a plugin to `trusted` after validating its manifest signature.
   */
  trustSigned(
    name: string,
    publicKey?: string,
  ): { ok: boolean; fingerprint?: string; error?: string } {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    const manifest = discovered.manifest as {
      name: string;
      version: string;
      capabilities?: string[];
      signature?: string;
    };

    const result = this.trustStore.trustSigned(name, manifest, publicKey);
    if (!result.ok) {
      return { ok: false, error: result.reason };
    }

    this.state.trust[name] = result.record;
    this.saveState();
    this.notifySubscribers();
    return { ok: true, fingerprint: result.record.signatureFingerprint };
  }

  /**
   * verify — Inspect a plugin's manifest signature without changing its tier.
   */
  verify(name: string, publicKey?: string): { ok: boolean } & SignatureValidationResult {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, valid: false, reason: this.notFoundError(name) };
    }

    const manifest = discovered.manifest as {
      name: string;
      version: string;
      capabilities?: string[];
      signature?: string;
    };

    const result = this.trustStore.verify(manifest, publicKey);
    return { ok: result.valid, ...result };
  }

  /**
   * capabilities — Return the capability information for a plugin.
   *
   * Returns the full set: requested, granted (based on current trust tier),
   * denied, and which capabilities are high-risk.
   */
  capabilities(name: string): {
    ok: boolean;
    error?: string;
    requested: string[];
    highRisk: string[];
    safe: string[];
    tier: PluginTrustTier;
    blocked: string[];
  } | null {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return null;
    }

    const manifest = discovered.manifest as { capabilities?: string[] };
    const requested = (manifest.capabilities ?? []) as PluginCapability[];
    const tier = this.trustStore.getTier(name);
    const highRisk = requested.filter((c) => isHighRiskCapability(c));
    const safe = requested.filter((c) => !isHighRiskCapability(c));
    // Capabilities blocked by current trust tier
    const blocked = tier !== 'trusted' ? highRisk : [];

    return { ok: true, requested, highRisk, safe, tier, blocked };
  }

  /**
   * quarantine — Apply quarantine to a plugin.
   *
   * This is the high-level operator path. It resolves the plugin's declared
   * capability manifest using the current trust tier, then applies quarantine
   * immediately to the resolved capability set.
   */
  quarantine(
    name: string,
    reason: string,
  ): { ok: boolean; error?: string } {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    if (this.quarantineEngine.isQuarantined(name)) {
      return { ok: false, error: `Plugin '${name}' is already quarantined` };
    }

    const trustTier = this.trustStore.getTier(name);
    const capabilityManifest = resolveCapabilityManifest(
      name,
      discovered.manifest as PluginManifestV2,
      undefined,
      trustTier,
    );

    const record = this.quarantineEngine.quarantine(name, capabilityManifest, reason);
    if (!record) {
      return { ok: false, error: `Failed to quarantine '${name}'` };
    }

    this.state.quarantine[name] = { ...record, revokedCapabilities: [...record.revokedCapabilities] };
    this.saveState();
    logger.warn(`[plugins] ${name}: quarantined — ${reason}`);
    this.notifySubscribers();
    return { ok: true };
  }

  /**
   * liftQuarantine — Remove quarantine from a plugin.
   */
  liftQuarantine(name: string): { ok: boolean; error?: string } {
    if (!this.quarantineEngine.isQuarantined(name)) {
      return { ok: false, error: `Plugin '${name}' is not quarantined` };
    }
    this.quarantineEngine.lift(name);
    const record = this.quarantineEngine.getRecord(name);
    if (record) {
      this.state.quarantine[name] = { ...record, revokedCapabilities: [...record.revokedCapabilities] };
    }
    this.saveState();
    logger.info(`[plugins] ${name}: quarantine lifted`);
    this.notifySubscribers();
    return { ok: true };
  }

  /** Enable a plugin by name. Loads it immediately if deps are available. */
  async enable(name: string): Promise<{ ok: boolean; error?: string }> {
    if (this.isEnabled(name)) {
      return { ok: false, error: `Plugin '${name}' is already enabled` };
    }

    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    this.state.enabled[name] = true;
    this.saveState();

    if (this.deps) {
      const loaded = await loadPlugin(discovered, this.deps);
      if (loaded) {
        this.plugins.set(name, loaded);
        this.notifySubscribers();
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
    this.notifySubscribers();
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
      const discovered = this.discoverPlugins();
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
    this.notifySubscribers();
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
    const discovered = this.discoverPlugins();
    for (const d of discovered) {
      if (!this.isEnabled(d.manifest.name)) continue;
      const loaded = await loadPlugin(d, this.deps);
      if (loaded) {
        this.plugins.set(d.manifest.name, loaded);
      }
    }
    this.notifySubscribers();
  }

  private loadState(): void {
    try {
      if (existsSync(this.stateFilePath)) {
        const raw = readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PluginState>;
        this.state.enabled = parsed.enabled ?? {};
        this.state.config = parsed.config ?? {};
        this.state.trust = parsed.trust ?? {};
        this.state.quarantine = parsed.quarantine ?? {};
        // Restore trust and quarantine state into their engines.
        if (Object.keys(this.state.trust).length > 0) {
          this.trustStore.importRecords(this.state.trust);
        }
        // Note: quarantine records are read-only from persistence; active
        // quarantines take effect when plugins are loaded via PluginLifecycleManager.
      }
    } catch (err) {
      logger.warn(`[plugins] Could not load state: ${String(err)}`);
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`[plugins] Could not save state: ${String(err)}`);
    }
  }

  private discoverPlugins() {
    return discoverPlugins(this.pathOptions);
  }

  private findDiscoveredPlugin(name: string) {
    return this.discoverPlugins().find((plugin) => plugin.manifest.name === name);
  }

  private notFoundError(name: string): string {
    return `Plugin '${name}' not found in configured plugin search directories (${this.describeSearchDirectories()})`;
  }

  private describeSearchDirectories(): string {
    return getPluginDirectories(this.pathOptions).join(', ');
  }

  private notifySubscribers(): void {
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch (err) {
        logger.debug('[plugins] subscriber callback failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

}
