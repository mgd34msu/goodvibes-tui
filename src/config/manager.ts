import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config/schema';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config/schema';
import { ConfigError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { HookDispatcher } from '../hooks/index.ts';
import type { HookEvent } from '@pellux/goodvibes-sdk/platform/hooks/types';
import { getManagedSettingLock } from '../runtime/settings/control-plane.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/** Deep immutable type — prevents mutation of nested objects returned from getAll(). */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/** Constructor overrides for CLI args and programmatic instantiation. */
interface ConfigCliOverrides {
  model?: string;
  provider?: string;
  autoApprove?: boolean;
  systemPromptFile?: string;
  workingDir?: string;
}

export type ConfigOverrides = ConfigCliOverrides & (
  | {
    configDir: string;
    homeDir?: string;
    sharedConfigPath?: string;
  }
  | {
    homeDir: string;
    configDir?: string;
    sharedConfigPath?: string;
  }
);

interface ConfigRoots {
  configDir?: string;
  homeDir?: string;
  sharedConfigPath?: string;
}

export interface ConfigSetOptions {
  bypassManagedLock?: boolean;
}

const DEFAULT_CONFIG_SNAPSHOT = structuredClone(DEFAULT_CONFIG) as GoodVibesConfig;
const PERMISSION_TOOL_KEYS = new Set(Object.keys(DEFAULT_CONFIG.permissions.tools));

function cloneDefaultConfig(): GoodVibesConfig {
  return structuredClone(DEFAULT_CONFIG_SNAPSHOT) as GoodVibesConfig;
}

function sanitizeConfigShape(config: GoodVibesConfig): GoodVibesConfig {
  const sanitized = structuredClone(config) as GoodVibesConfig;
  const lineNumbers = (sanitized.display as Record<string, unknown>).lineNumbers;
  if (typeof lineNumbers === 'boolean') {
    sanitized.display.lineNumbers = lineNumbers ? 'all' : 'off';
  }
  for (const key of Object.keys(sanitized.permissions.tools)) {
    if (!PERMISSION_TOOL_KEYS.has(key)) {
      delete (sanitized.permissions.tools as Record<string, unknown>)[key];
    }
  }
  return sanitized;
}

function requireAbsoluteOwnedPath(path: string | undefined, name: string): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`ConfigManager ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`ConfigManager ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

/**
 * Ensure the shared ~/.goodvibes/goodvibes.json exists (empty object if not).
 * This is reserved for future cross-app use — no TUI settings go here.
 */
function ensureSharedConfig(sharedPath: string): void {
  if (!existsSync(sharedPath)) {
    mkdirSync(dirname(sharedPath), { recursive: true });
    try {
      writeFileSync(sharedPath, '{}\n', 'utf-8');
    } catch (err) {
      logger.debug('Could not create shared goodvibes.json (non-fatal)', { error: summarizeError(err) });
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
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly projectConfigPath: string | null;
  private readonly workingDirectory: string | null;
  private readonly homeDirectory: string | null;
  private hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null;

  constructor(overrides: ConfigOverrides) {
    const roots = overrides as ConfigRoots;
    const configDir = requireAbsoluteOwnedPath(roots.configDir, 'configDir');
    const homeDirectory = requireAbsoluteOwnedPath(roots.homeDir, 'homeDir') ?? null;
    const workingDirectory = requireAbsoluteOwnedPath(overrides.workingDir, 'workingDir') ?? null;
    const sharedConfigPath = requireAbsoluteOwnedPath(roots.sharedConfigPath, 'sharedConfigPath');
    const base = configDir ?? join(homeDirectory!, '.goodvibes', 'tui');
    this.configDir = base;
    this.configPath = join(base, 'settings.json');
    this.workingDirectory = workingDirectory;
    this.homeDirectory = homeDirectory;
    this.projectConfigPath = this.workingDirectory
      ? join(this.workingDirectory, '.goodvibes', 'tui', 'settings.json')
      : null;
    this.config = cloneDefaultConfig();

    const ownedSharedConfigPath = sharedConfigPath ?? (
      this.homeDirectory ? join(this.homeDirectory, '.goodvibes', 'goodvibes.json') : null
    );
    if (ownedSharedConfigPath) {
      ensureSharedConfig(ownedSharedConfigPath);
    }

    this.load();

    // Apply constructor overrides (CLI args, etc.) after load
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

  getControlPlaneConfigDir(): string {
    return this.configDir;
  }

  getWorkingDirectory(): string | null {
    return this.workingDirectory;
  }

  getHomeDirectory(): string | null {
    return this.homeDirectory;
  }

  attachHookDispatcher(hookDispatcher: Pick<HookDispatcher, 'fire'> | null): void {
    this.hookDispatcher = hookDispatcher;
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

  /** Get a config value by dot-path key. */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.resolvePath(key);
    return parent[field] as ConfigValue<K>;
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    const schema = CONFIG_SCHEMA.find(s => s.key === key);
    if (schema?.validate && !schema.validate(value)) {
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
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
    if (!this.hookDispatcher) return;
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
      this.hookDispatcher
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
  setDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.set(key, value as never, options);
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
      logger.debug('Config save failed (non-fatal)', { error: summarizeError(err) });
    }
  }

  /** Persist current config to project-level TUI settings file (.goodvibes/tui/settings.json). */
  saveProject(): void {
    if (!this.projectConfigPath) {
      throw new Error('ConfigManager.saveProject requires an explicit workingDir.');
    }
    try {
      mkdirSync(dirname(this.projectConfigPath), { recursive: true });
      writeFileSync(this.projectConfigPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
    } catch (err) {
      logger.debug('Project config save failed (non-fatal)', { error: summarizeError(err) });
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
        logger.debug('Global config load failed (non-fatal, using defaults)', { error: summarizeError(err) });
      }
    }

    // Load project settings and deep-merge on top (project wins)
    if (this.projectConfigPath && existsSync(this.projectConfigPath)) {
      try {
        const raw = readFileSync(this.projectConfigPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        this.config = sanitizeConfigShape(deepMerge(this.config, parsed) as GoodVibesConfig);
      } catch (err) {
        logger.debug('Project config load failed (non-fatal)', { error: summarizeError(err) });
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
      const livePath = this.resolvePath(key);
      const defaultPath = resolveArbitraryPath(DEFAULT_CONFIG_SNAPSHOT as unknown as Record<string, unknown>, key);
      livePath.parent[livePath.field] = structuredClone(defaultPath.parent[defaultPath.field]);
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

function resolveArbitraryPath(
  root: Record<string, unknown>,
  key: string,
): { parent: Record<string, unknown>; field: string } {
  const parts = key.split('.');
  let cursor: unknown = root;
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
