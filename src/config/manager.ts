import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.ts';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.ts';
import { ConfigError } from '../types/errors.ts';
import { logger } from '../utils/logger.ts';
import { getHookDispatcher } from '../hooks/index.ts';
import type { HookEvent } from '../hooks/types.ts';

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
  configDir?: string;
}

const DEFAULT_CONFIG_SNAPSHOT = structuredClone(DEFAULT_CONFIG) as GoodVibesConfig;
const PERMISSION_TOOL_KEYS = new Set(Object.keys(DEFAULT_CONFIG.permissions.tools));

function cloneDefaultConfig(): GoodVibesConfig {
  return structuredClone(DEFAULT_CONFIG_SNAPSHOT) as GoodVibesConfig;
}

function sanitizeConfigShape(config: GoodVibesConfig): GoodVibesConfig {
  const sanitized = structuredClone(config) as GoodVibesConfig;
  for (const key of Object.keys(sanitized.permissions.tools)) {
    if (!PERMISSION_TOOL_KEYS.has(key)) {
      delete (sanitized.permissions.tools as Record<string, unknown>)[key];
    }
  }
  return sanitized;
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
    const configDirOverride = overrides?.configDir;
    const base = configDirOverride ?? ConfigManager.testConfigDir ?? join(homedir(), '.goodvibes', 'tui');
    this.configPath = join(base, 'settings.json');
    const projectRoot = overrides?.workingDir ?? process.cwd();
    this.projectConfigPath = join(projectRoot, '.goodvibes', 'tui', 'settings.json');
    this.config = cloneDefaultConfig();

    // Ensure shared config exists
    if (!configDirOverride) {
      ensureSharedConfig();
    }

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

  private resolvePath(
    key: ConfigKey,
  ): { parent: Record<string, unknown>; field: string } {
    const parts = key.split('.');
    let cursor: unknown = this.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as Record<string, unknown>))) {
        throw new Error(`Invalid config path: section '${parts.slice(0, i + 1).join('.')}' does not exist`);
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }

    if (cursor == null || typeof cursor !== 'object') {
      throw new Error(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
    }

    return {
      parent: cursor as Record<string, unknown>,
      field: parts[parts.length - 1]!,
    };
  }

  /** Get a config value by dot-path key. Supports 2-level (a.b) and 3-level (a.b.c) keys. */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.resolvePath(key);
    return parent[field] as ConfigValue<K>;
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

    const { parent, field } = this.resolvePath(key);
    const previousValue = parent[field];
    parent[field] = value;
    this.save();
    this.emitConfigHook(key, previousValue, value);
  }

  /**
   * Fire the Change:config hook for a config key change.
   * Best-effort: the hook dispatcher may not be initialised during startup.
   */
  private emitConfigHook(key: ConfigKey, previousValue: unknown, newValue: unknown): void {
    try {
      const event: HookEvent = {
        path: `Change:config:${key}`,
        phase: 'Change',
        category: 'config',
        specific: key,
        sessionId: '',
        timestamp: Date.now(),
        payload: { key, value: newValue, previousValue },
      };
      getHookDispatcher()
        .fire(event)
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

        this.config = sanitizeConfigShape(deepMerge(cloneDefaultConfig(), parsed) as GoodVibesConfig);
      } catch (err) {
        logger.debug('Global config load failed (non-fatal, using defaults)', { error: String(err) });
      }
    }

    // Load project settings and deep-merge on top (project wins)
    if (existsSync(this.projectConfigPath)) {
      try {
        const raw = readFileSync(this.projectConfigPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        this.config = sanitizeConfigShape(deepMerge(this.config, parsed) as GoodVibesConfig);
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
      this.config = cloneDefaultConfig();
    } else {
      const schema = CONFIG_SCHEMA.find(s => s.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const parts = key.split('.');
      if (parts.length === 3) {
        const [section, subsection, field] = parts;
        const sect = this.config[section as keyof GoodVibesConfig] as unknown as Record<string, Record<string, unknown>>;
        const defaultSect = DEFAULT_CONFIG_SNAPSHOT[section as keyof GoodVibesConfig] as unknown as Record<string, Record<string, unknown>>;
        sect[subsection][field] = defaultSect[subsection][field];
      } else {
        const [category, field] = parts;
        const cat = this.config[category as keyof GoodVibesConfig] as Record<string, unknown>;
        const defaultCat = DEFAULT_CONFIG_SNAPSHOT[category as keyof GoodVibesConfig] as Record<string, unknown>;
        cat[field] = defaultCat[field];
      }
    }
    this.save();
  }
}

/** Deep-merge source into target. Returns a new object. Source non-objects are ignored — target clone is returned.
 * Non-object source values will not overwrite object target values (type-safe merge). */
function deepMerge(target: unknown, source: unknown): unknown {
  const result: Record<string, unknown> = isObject(target)
    ? structuredClone(target) as Record<string, unknown>
    : {};
  if (!isObject(source)) return result;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (isObject(sv) && isObject(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined && !isObject(tv)) {
      // Only overwrite non-object target values — never replace an object with a scalar.
      // Clone assigned values so config instances never share mutable references.
      result[key] = structuredClone(sv);
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}
