import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.ts';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.ts';
import { ConfigError } from '../types/errors.ts';
import { logger } from '../utils/logger.ts';
import { getHookDispatcher } from '../hooks/index.ts';

/** Deep immutable type — prevents mutation of nested objects returned from getAll(). */
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/** Constructor overrides for CLI args and programmatic instantiation. */
export interface ConfigOverrides {
  model?: string;
  provider?: string;
  autoApprove?: boolean;
  systemPromptFile?: string;
  workingDir?: string;
}

/** Auto-migrate: copy old path to new path if old exists and new doesn't. */
function migrateIfNeeded(oldPath: string, newPath: string): void {
  if (existsSync(oldPath) && !existsSync(newPath)) {
    mkdirSync(dirname(newPath), { recursive: true });
    try {
      copyFileSync(oldPath, newPath);
      logger.debug('Migrated config', { from: oldPath, to: newPath });
    } catch (err: unknown) {
      // Silently ignore EEXIST — newPath was created between check and copy
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * Ensure the shared ~/.goodvibes/goodvibes.json exists (empty object if not).
 * This is reserved for future cross-app use — no TUI settings go here.
 */
function ensureSharedConfig(): void {
  const sharedPath = join(homedir(), '.goodvibes', 'goodvibes.json');
  if (!existsSync(sharedPath)) {
    mkdirSync(dirname(sharedPath), { recursive: true });
    try {
      writeFileSync(sharedPath, '{}\n', 'utf-8');
    } catch (err) {
      logger.debug('Could not create shared goodvibes.json (non-fatal)', { error: String(err) });
    }
  }
}

/**
 * ConfigManager — Layered, mutable, persistent config system.
 *
 * Load order: defaults < global TUI settings < project TUI settings < CLI overrides
 * API keys are never persisted — loaded from env vars only.
 */
export class ConfigManager {
  private config: GoodVibesConfig;
  private readonly configPath: string;
  private readonly projectConfigPath: string;

  /**
   * Override the config directory for test isolation.
   * Call before instantiating ConfigManager in tests.
   * Resets on process exit or explicit call with undefined.
   */
  private static testConfigDir: string | undefined = undefined;

  static setTestMode(tempDir: string | undefined): void {
    ConfigManager.testConfigDir = tempDir;
  }

  constructor(overrides?: ConfigOverrides) {
    const base = ConfigManager.testConfigDir ?? join(homedir(), '.goodvibes', 'tui');
    this.configPath = join(base, 'settings.json');
    const projectRoot = overrides?.workingDir ?? process.cwd();
    this.projectConfigPath = join(projectRoot, '.goodvibes', 'tui', 'settings.json');
    this.config = deepMerge(DEFAULT_CONFIG, {}) as GoodVibesConfig;

    // Auto-migrate from old path if needed (skip in test mode — test dir is fresh)
    if (!ConfigManager.testConfigDir) {
      migrateIfNeeded(
        join(homedir(), '.config', 'goodvibes', 'config.json'),
        this.configPath
      );
    }

    // Ensure shared config exists
    ensureSharedConfig();

    this.load();

    // Apply constructor overrides (CLI args, etc.) after load
    if (overrides) {
      if (overrides.model !== undefined) {
        this.config.provider.model = overrides.model;
      }
      if (overrides.provider !== undefined) {
        this.config.provider.provider = overrides.provider;
      }
      if (overrides.autoApprove !== undefined) {
        this.config.behavior.autoApprove = overrides.autoApprove;
      }
      if (overrides.systemPromptFile !== undefined) {
        this.config.provider.systemPromptFile = overrides.systemPromptFile;
      }
    }
  }

  /** Get a config value by dot-path key. Supports 2-level (a.b) and 3-level (a.b.c) keys. */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const parts = key.split('.');
    if (parts.length === 3) {
      const [section, subsection, field] = parts;
      const sect = this.config[section as keyof GoodVibesConfig] as unknown as Record<string, Record<string, unknown>>;
      // Intentional: the config schema guarantees all valid keys have values, so this
      // path only triggers for dynamically constructed invalid keys (e.g., unknown subsections).
      if (!sect?.[subsection]) return undefined as unknown as ConfigValue<K>;
      return sect[subsection][field] as ConfigValue<K>;
    }
    const [category, field] = parts;
    const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
    if (cat == null) throw new Error(`Invalid config path: section '${category}' does not exist`);
    return cat[field] as ConfigValue<K>;
  }

  /** Set a config value by dot-path key and auto-save to disk. Supports 2-level and 3-level keys. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    const schema = CONFIG_SCHEMA.find(s => s.key === key);
    if (schema?.validate && !schema.validate(value)) {
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }

    const parts = key.split('.');
    if (parts.length === 3) {
      const [section, subsection, field] = parts;
      const sect = this.config[section as keyof GoodVibesConfig] as unknown as Record<string, Record<string, unknown>>;
      if (!sect[subsection]) throw new Error(`Invalid config path: subsection '${section}.${subsection}' does not exist`);
      const previousValue = sect[subsection][field];
      sect[subsection][field] = value;
      this.save();
      this.emitConfigHook(key, previousValue, value);
      return;
    }
    const [category, field] = parts;
    const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
    const previousValue = cat[field];
    cat[field] = value;
    this.save();
    this.emitConfigHook(key, previousValue, value);
  }

  /**
   * Fire the Change:config hook for a config key change.
   * Best-effort: the hook dispatcher may not be initialised during startup.
   */
  private emitConfigHook(key: ConfigKey, previousValue: unknown, newValue: unknown): void {
    try {
      getHookDispatcher()
        .fire({
          path: `Change:config:${key}` as any,
          phase: 'Change' as any,
          category: 'config' as any,
          specific: key,
          sessionId: '',
          timestamp: Date.now(),
          payload: { key, value: newValue, previousValue },
        })
        .catch(() => { /* ignore async errors */ });
    } catch {
      // Dispatcher not ready during startup — safe to ignore
    }
  }

  /**
   * Set a config value from a validated ConfigKey with unknown value type.
   * Used when iterating schema entries where the value type cannot be statically
   * inferred. Runtime validation is still applied by the underlying set() method.
   */
  setDynamic(key: ConfigKey, value: unknown): void {
    this.set(key, value as never);
  }

  /** Return a deep-readonly snapshot of the full config. Nested objects are immutable. */
  getAll(): DeepReadonly<GoodVibesConfig> {
    return structuredClone(this.config) as DeepReadonly<GoodVibesConfig>;
  }

  /** Return a deep-cloned snapshot of a config category. */
  getCategory<C extends keyof GoodVibesConfig>(category: C): Readonly<GoodVibesConfig[C]> {
    return structuredClone(this.config[category]);
  }

  /** Return a deep-cloned snapshot of the live config. Safe for read-only external consumers. */
  getRaw(): Readonly<GoodVibesConfig> {
    return structuredClone(this.config) as Readonly<GoodVibesConfig>;
  }

  /** Return the full schema. */
  getSchema(): ConfigSetting[] {
    return CONFIG_SCHEMA;
  }

  /** Persist current config to global TUI settings file. */
  save(): void {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    } catch (err) {
      logger.debug('Config save failed (non-fatal)', { error: String(err) });
    }
  }

  /** Persist current config to project-level TUI settings file (.goodvibes/tui/settings.json). */
  saveProject(): void {
    try {
      mkdirSync(dirname(this.projectConfigPath), { recursive: true });
      writeFileSync(this.projectConfigPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    } catch (err) {
      logger.debug('Project config save failed (non-fatal)', { error: String(err) });
    }
  }

  /** Load config from disk: global then project (project wins). Deep-merges with defaults. */
  load(): void {
    // Load global settings
    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;

        // Auto-migrate: detect old flat format (has top-level 'model' or 'provider' string keys)
        if (typeof parsed.model === 'string' || typeof parsed.provider === 'string') {
          const migrated = migrateOldConfig(parsed);
          this.config = deepMerge(DEFAULT_CONFIG, migrated) as GoodVibesConfig;
          // Save the migrated format
          this.save();
        } else {
          this.config = deepMerge(DEFAULT_CONFIG, parsed) as GoodVibesConfig;
        }
      } catch (err) {
        logger.debug('Global config load failed (non-fatal, using defaults)', { error: String(err) });
      }
    }

    // Load project settings and deep-merge on top (project wins)
    if (existsSync(this.projectConfigPath)) {
      try {
        const raw = readFileSync(this.projectConfigPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        this.config = deepMerge(this.config, parsed) as GoodVibesConfig;
      } catch (err) {
        logger.debug('Project config load failed (non-fatal)', { error: String(err) });
      }
    }
  }

  /**
   * Merge a partial patch into a config category and auto-save.
   *
   * This is the correct way to update array or object fields within a category
   * that cannot be expressed as a scalar dot-path key (e.g. notifications.webhookUrls).
   * The patch is shallow-merged into the existing category value.
   */
  mergeCategory<C extends keyof GoodVibesConfig>(category: C, patch: Partial<GoodVibesConfig[C]>): void {
    const current = this.config[category] as Record<string, unknown>;
    const patchObj = patch as Record<string, unknown>;
    for (const key of Object.keys(patchObj)) {
      if (patchObj[key] !== undefined) {
        current[key] = patchObj[key];
      }
    }
    this.save();
  }

  /**
   * Reset a specific key to its default, or reset all config.
   * Saves to disk after reset.
   */
  reset(key?: ConfigKey): void {
    if (key === undefined) {
      this.config = deepMerge(DEFAULT_CONFIG, {}) as GoodVibesConfig;
    } else {
      const schema = CONFIG_SCHEMA.find(s => s.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const parts = key.split('.');
      if (parts.length === 3) {
        const [section, subsection, field] = parts;
        const sect = this.config[section as keyof GoodVibesConfig] as unknown as Record<string, Record<string, unknown>>;
        const defaultSect = DEFAULT_CONFIG[section as keyof GoodVibesConfig] as unknown as Record<string, Record<string, unknown>>;
        sect[subsection][field] = defaultSect[subsection][field];
      } else {
        const [category, field] = parts;
        const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
        const defaultCat = DEFAULT_CONFIG[category as keyof GoodVibesConfig] as Record<string, unknown>;
        cat[field] = defaultCat[field];
      }
    }
    this.save();
  }
}

/** Deep-merge source into target. Returns a new object. Source non-objects are ignored — target clone is returned.
 * Non-object source values will not overwrite object target values (type-safe merge). */
function deepMerge(target: unknown, source: unknown): unknown {
  const result: Record<string, unknown> = isObject(target) ? { ...target } : {};
  if (!isObject(source)) return result;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (isObject(sv) && isObject(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined && !isObject(tv)) {
      // Only overwrite non-object target values — never replace an object with a scalar
      result[key] = sv;
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/** Migrate old flat config format to nested GoodVibesConfig format. */
function migrateOldConfig(flat: Record<string, unknown>): Partial<GoodVibesConfig> {
  const result: Partial<GoodVibesConfig> = {};

  const providerFields: Partial<GoodVibesConfig['provider']> = {};
  if (typeof flat.model === 'string') providerFields.model = flat.model;
  if (typeof flat.provider === 'string') providerFields.provider = flat.provider;
  if (typeof flat.systemPrompt === 'string') {
    // systemPrompt text doesn't map to systemPromptFile cleanly; skip it
  }
  if (Object.keys(providerFields).length > 0) {
    // Safe: providerFields satisfies GoodVibesConfig['provider'] shape after migration validation above
    result.provider = providerFields as GoodVibesConfig['provider'];
  }

  const behaviorFields: Partial<GoodVibesConfig['behavior']> = {};
  if (typeof flat.autoApprove === 'boolean') behaviorFields.autoApprove = flat.autoApprove;
  if (Object.keys(behaviorFields).length > 0) {
    result.behavior = behaviorFields as GoodVibesConfig['behavior'];
  }

  return result;
}
