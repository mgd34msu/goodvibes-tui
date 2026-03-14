import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.ts';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.ts';
import { ConfigError } from '../types/errors.ts';
import { logger } from '../utils/logger.ts';

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

/**
 * ConfigManager — Layered, mutable, persistent config system.
 *
 * Load order: defaults < global config file < CLI overrides
 * API keys are never persisted — loaded from env vars only.
 */
export class ConfigManager {
  private config: GoodVibesConfig;
  private readonly configPath: string;

  constructor(overrides?: ConfigOverrides) {
    this.configPath = join(homedir(), '.config', 'goodvibes', 'config.json');
    this.config = deepMerge(DEFAULT_CONFIG, {}) as GoodVibesConfig;
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

  /** Get a config value by dot-path key. */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const [category, field] = key.split('.');
    const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
    return cat[field] as ConfigValue<K>;
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    const schema = CONFIG_SCHEMA.find(s => s.key === key);
    if (schema?.validate && !schema.validate(value)) {
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }

    const [category, field] = key.split('.');
    const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
    cat[field] = value;
    this.save();
  }

  /** Return a deep-readonly snapshot of the full config. Nested objects are immutable. */
  getAll(): DeepReadonly<GoodVibesConfig> {
    return structuredClone(this.config) as DeepReadonly<GoodVibesConfig>;
  }

  /** Return a config category. */
  getCategory(category: 'display' | 'provider' | 'behavior'): Readonly<GoodVibesConfig[typeof category]> {
    return this.config[category];
  }

  /** Return the full schema. */
  getSchema(): ConfigSetting[] {
    return CONFIG_SCHEMA;
  }

  /** Persist current config to disk. Never writes apiKeys. */
  save(): void {
    try {
      const dir = join(homedir(), '.config', 'goodvibes');
      mkdirSync(dir, { recursive: true });
      // Persist only the nested config structure (no apiKeys)
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    } catch (err) {
      logger.debug('Config save failed (non-fatal)', { error: String(err) });
    }
  }

  /** Load config from disk and deep-merge with defaults. */
  load(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Auto-migrate: detect old flat format (has top-level 'model' or 'provider' string keys)
      if (typeof parsed.model === 'string' || typeof parsed.provider === 'string') {
        const migrated = migrateOldConfig(parsed);
        this.config = deepMerge(DEFAULT_CONFIG, migrated) as GoodVibesConfig;
        // Save the migrated format
        this.save();
        return;
      }

      this.config = deepMerge(DEFAULT_CONFIG, parsed) as GoodVibesConfig;
    } catch (err) {
      logger.debug('Config load failed (non-fatal, using defaults)', { error: String(err) });
    }
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
      const [category, field] = key.split('.');
      const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
      const defaultCat = DEFAULT_CONFIG[category as keyof GoodVibesConfig] as Record<string, unknown>;
      cat[field] = defaultCat[field];
    }
    this.save();
  }
}

/** Deep-merge source into target. Returns a new object. */
function deepMerge(target: unknown, source: unknown): unknown {
  if (!isObject(target) || !isObject(source)) return target;
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key as keyof typeof target];
    if (isObject(sv) && isObject(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined) {
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
    result.provider = providerFields as GoodVibesConfig['provider'];
  }

  const behaviorFields: Partial<GoodVibesConfig['behavior']> = {};
  if (typeof flat.autoApprove === 'boolean') behaviorFields.autoApprove = flat.autoApprove;
  if (Object.keys(behaviorFields).length > 0) {
    result.behavior = behaviorFields as GoodVibesConfig['behavior'];
  }

  return result;
}
