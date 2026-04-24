import type { ConfigKey, ConfigManager, ConfigSetting, GoodVibesConfig, PersistedFlagState } from '../config/index.ts';
import { CONFIG_SCHEMA, ConfigError } from '../config/index.ts';
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

export function applyRuntimeFeatureFlagOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): void {
  if (options.enableFeatures.length === 0 && options.disableFeatures.length === 0) return;
  const config = getRuntimeConfig(configManager);
  const flags = { ...config.featureFlags };
  for (const feature of options.enableFeatures) {
    flags[feature] = 'enabled' satisfies PersistedFlagState;
  }
  for (const feature of options.disableFeatures) {
    flags[feature] = 'disabled' satisfies PersistedFlagState;
  }
  config.featureFlags = flags;
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
