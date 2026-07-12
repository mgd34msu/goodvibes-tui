import { existsSync, readFileSync } from 'node:fs';
import type { ConfigKey, ConfigManager, ConfigSetting, GoodVibesConfig } from '../config/index.ts';
import { CONFIG_SCHEMA, ConfigError } from '../config/index.ts';
import { featureEnablementWrite, getFeatureSetting } from '../runtime/feature-settings.ts';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './types.ts';
import { RUNTIME_ENDPOINT_CONFIG_KEYS, hostModeForHostname } from './endpoints.ts';
import type { RuntimeEndpointId } from './endpoints.ts';

const CONFIG_SCHEMA_BY_KEY = new Map<string, ConfigSetting>(
  CONFIG_SCHEMA.map((setting) => [setting.key, setting]),
);

function parseConfigOverrideValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
}

function getRuntimeConfig(configManager: ConfigManager): GoodVibesConfig {
  const mutable = configManager as unknown as { config?: GoodVibesConfig };
  if (!mutable.config || typeof mutable.config !== 'object') {
    throw new ConfigError('ConfigManager runtime config is not available for CLI overrides.');
  }
  return mutable.config;
}

function validateConfigValue(setting: ConfigSetting, value: unknown): void {
  if (setting.type === 'boolean' && typeof value !== 'boolean') {
    throw new ConfigError(`Invalid value for ${setting.key}: expected boolean.`);
  }
  if (setting.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ConfigError(`Invalid value for ${setting.key}: expected number.`);
  }
  if (setting.type === 'string' && typeof value !== 'string') {
    throw new ConfigError(`Invalid value for ${setting.key}: expected string.`);
  }
  if (setting.type === 'enum' && setting.enumValues && !setting.enumValues.includes(String(value))) {
    throw new ConfigError(`Invalid value for ${setting.key}: "${String(value)}". Allowed: ${setting.enumValues.join(', ')}`);
  }
  if (setting.validate && !setting.validate(value)) {
    throw new ConfigError(`Invalid value for ${setting.key}: ${String(value)}`);
  }
}

function setNestedConfigValue(config: GoodVibesConfig, key: ConfigKey, value: unknown): void {
  const parts = key.split('.');
  let cursor: unknown = config;
  for (const part of parts.slice(0, -1)) {
    if (cursor == null || typeof cursor !== 'object' || !(part in cursor)) {
      throw new ConfigError(`Invalid config path: section '${part}' does not exist`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor == null || typeof cursor !== 'object') {
    throw new ConfigError(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
  }
  (cursor as Record<string, unknown>)[parts[parts.length - 1]!] = value;
}

/**
 * Typed accessor for the SDK's private file paths on ConfigManager.
 *
 * SDK coupling: configPath and projectConfigPath are declared `private readonly`
 * in the SDK's ConfigManager (see manager.d.ts — configPath, projectConfigPath). No public accessors exist
 * as of the SDK version pinned in this project. This cast is the narrowest
 * possible workaround. SDK public-accessor request: see HANDOFF-FROM-TUI-SESSION-20260611.md,
 * Item 6 area. If the SDK ever exposes getConfigPath()/getProjectConfigPath(), replace
 * this cast with those calls and remove this comment.
 *
 * Fail-open: if the cast produces undefined (SDK internal rename), the paths are
 * treated as absent and the default is applied safely.
 */
function getPersistedPaths(configManager: ConfigManager): { configPath: string | undefined; projectConfigPath: string | undefined } {
  const manager = configManager as unknown as { configPath?: string; projectConfigPath?: string };
  return {
    configPath: typeof manager.configPath === 'string' ? manager.configPath : undefined,
    projectConfigPath: typeof manager.projectConfigPath === 'string' ? manager.projectConfigPath : undefined,
  };
}

/**
 * Returns true if the given dot-path key is explicitly present anywhere
 * in the provided raw JSON object.
 */
function isKeyPresentInRaw(raw: Record<string, unknown>, key: ConfigKey): boolean {
  const parts = key.split('.');
  let cursor: unknown = raw;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as object))) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return true;
}

/**
 * Apply a TUI default to a config key, but ONLY if the user has not explicitly
 * set the key in EITHER their global OR project persisted settings files.
 * Reads the raw settings JSON from disk (bypasses the in-memory merged config)
 * so a user's explicit `false` in either file is never silently overridden at startup.
 *
 * Each settings file is read independently: a parse failure on one file
 * contributes nothing but does NOT prevent the other file from being checked.
 * The default is applied only when the key is absent from every readable file
 * (e.g. new install, both files missing, or both unparseable).
 */
export function applyRuntimeConfigDefault(configManager: ConfigManager, key: ConfigKey, defaultValue: unknown): void {
  const { configPath, projectConfigPath } = getPersistedPaths(configManager);
  // Check each settings file independently. A read/parse failure on one path
  // contributes nothing but must not prevent the other path from being checked.
  for (const filePath of [configPath, projectConfigPath]) {
    if (typeof filePath !== 'string' || !existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      if (isKeyPresentInRaw(raw, key)) {
        // Key is explicitly set in this persisted config — respect the user's value.
        return;
      }
    } catch {
      // Unreadable or malformed JSON — this file contributes nothing; continue to next.
    }
  }
  applyRuntimeConfigValue(configManager, key, defaultValue);
}

/**
 * Every TUI-side config default applied at startup, in one place. Currently:
 * show token speed ON (the SDK schema default is false). applyRuntimeConfigDefault
 * reads the global + project settings files and only applies the default
 * in-memory when the key is absent from both (e.g. a new install); an explicit
 * user value is respected. No disk write.
 */
export function applyTuiRuntimeConfigDefaults(configManager: ConfigManager): void {
  applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);
}

/**
 * Applies the persisted `behavior.hitlMode` config value to the live mode
 * manager at startup, ignoring unset or unrecognized values. Extracted from
 * main() verbatim (a plain move, no behavior change).
 */
export function applyConfiguredHitlMode(
  configManager: ConfigManager,
  modeManager: { setHITLMode(mode: 'quiet' | 'balanced' | 'operator'): void },
): void {
  const hitlMode = configManager.get('behavior.hitlMode');
  if (hitlMode === 'quiet' || hitlMode === 'balanced' || hitlMode === 'operator') {
    modeManager.setHITLMode(hitlMode);
  }
}

export function applyRuntimeConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  const setting = CONFIG_SCHEMA_BY_KEY.get(key);
  if (!setting) {
    throw new ConfigError(`Unknown config key: ${key}`);
  }
  validateConfigValue(setting, value);
  setNestedConfigValue(getRuntimeConfig(configManager), key, value);
}

export function applyRuntimeConfigOverrides(
  configManager: ConfigManager,
  overrides: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  for (const override of overrides) {
    const index = override.indexOf('=');
    if (index <= 0) {
      errors.push(`Invalid --config override "${override}". Expected key=value.`);
      continue;
    }
    const key = override.slice(0, index) as ConfigKey;
    const rawValue = override.slice(index + 1);
    try {
      applyRuntimeConfigValue(configManager, key, parseConfigOverrideValue(rawValue));
    } catch (error) {
      errors.push(error instanceof Error ? `Invalid --config ${override}: ${error.message}` : `Invalid --config ${override}`);
    }
  }
  return errors;
}

/**
 * Session-only feature overrides (--enable-feature / --disable-feature).
 * Each feature is switched through its real domain settings key (e.g.
 * sandbox.enabled, behavior.compactionStrategy) in the runtime config layer;
 * features without an off position (constant capabilities on non-boolean
 * keys) and unknown ids are reported as errors rather than silently ignored.
 */
export function applyRuntimeFeatureFlagOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): readonly string[] {
  if (options.enableFeatures.length === 0 && options.disableFeatures.length === 0) return [];
  const config = getRuntimeConfig(configManager);
  const errors: string[] = [];
  const apply = (feature: string, enabled: boolean, flagName: string): void => {
    const write = featureEnablementWrite(feature, enabled);
    if (!write) {
      errors.push(getFeatureSetting(feature)
        ? `${flagName} ${feature}: this capability has no ${enabled ? 'on' : 'off'} switch (its domain settings govern it directly).`
        : `${flagName} ${feature}: unknown feature id.`);
      return;
    }
    setNestedConfigValue(config, write.key, write.value);
  };
  for (const feature of options.enableFeatures) apply(feature, true, '--enable-feature');
  for (const feature of options.disableFeatures) apply(feature, false, '--disable-feature');
  return errors;
}

export function applyRuntimeEndpointFlagOverrides(
  configManager: ConfigManager,
  endpoint: RuntimeEndpointId,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const errors: string[] = [];

  if (flags.hostname !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.hostMode, hostModeForHostname(flags.hostname));
      applyRuntimeConfigValue(configManager, keys.host, flags.hostname);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --hostname ${flags.hostname}: ${error.message}`
        : `Invalid --hostname ${flags.hostname}`);
    }
  }

  if (flags.port !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.port, flags.port);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --port ${flags.port}: ${error.message}`
        : `Invalid --port ${flags.port}`);
    }
  }

  return errors;
}

export function applyRuntimeCommandEndpointFlagOverrides(
  configManager: ConfigManager,
  command: GoodVibesCliCommand,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  if (flags.hostname === undefined && flags.port === undefined) return [];
  if (command === 'web') return applyRuntimeEndpointFlagOverrides(configManager, 'web', flags);
  if (command === 'listener') return applyRuntimeEndpointFlagOverrides(configManager, 'httpListener', flags);
  if (command === 'control-plane' || command === 'pair' || command === 'serve') {
    return applyRuntimeEndpointFlagOverrides(configManager, 'controlPlane', flags);
  }
  return [];
}
