/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all types from the new config system
 * - Backward-compatible `AppConfig` interface and `config` singleton
 *   so all existing `import { config } from '../config/index.ts'` usages work
 */

export { ConfigManager } from './manager.ts';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig } from './schema.ts';
export { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.ts';
export { ConfigError } from '../types/errors.ts';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.ts';
import type { GoodVibesConfig } from './schema.ts';
import { logger } from '../utils/logger.ts';

/**
 * AppConfig - Backward-compatible interface.
 * Maps the old flat AppConfig shape to the new nested GoodVibesConfig.
 */
export interface AppConfig {
  provider: string;
  model: string;
  apiKeys: Record<string, string>;
  autoApprove: boolean;
  workingDir: string;
  systemPrompt?: string;
}

/** Lazy singleton — initialized on first access to avoid sync I/O at import time. */
let _configManager: ConfigManager | undefined;
export function getConfigManager(): ConfigManager {
  if (!_configManager) _configManager = new ConfigManager();
  return _configManager;
}

/** Backward-compatible export — delegates to the lazy singleton. */
export const configManager: ConfigManager = new Proxy({} as ConfigManager, {
  get(_target, prop: string | symbol) {
    return (getConfigManager() as unknown as Record<string | symbol, unknown>)[prop];
  },
  set(_target, prop: string | symbol, value: unknown) {
    (getConfigManager() as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
});

/**
 * config - Backward-compatible singleton.
 * Returns a live view of the config as AppConfig-shaped object.
 * All existing `import { config } from '../config/index.ts'` usages work unchanged.
 */
export const config: AppConfig & Readonly<GoodVibesConfig> = new Proxy(
  {} as AppConfig & Readonly<GoodVibesConfig>,
  {
    get(_target, prop: string) {
      const raw = getConfigManager().getRaw();
      // AppConfig compat properties
      if (prop === 'provider') return raw.provider.provider;
      if (prop === 'model') return raw.provider.model;
      if (prop === 'apiKeys') return loadEnvApiKeys();
      if (prop === 'autoApprove') return raw.behavior.autoApprove;
      if (prop === 'workingDir') return process.cwd();
      if (prop === 'systemPrompt') {
        const file = raw.provider.systemPromptFile;
        if (!file) return undefined;
        try {
          return readFileSync(file, 'utf-8') as string;
        } catch (err) {
          logger.debug('systemPrompt file read failed (non-fatal)', { file, error: String(err) });
          return undefined;
        }
      }
      // GoodVibesConfig nested access (display, behavior, provider categories)
      if (prop in raw) return raw[prop as keyof typeof raw];
      return undefined;
    },
  }
) as AppConfig & Readonly<GoodVibesConfig>;

function loadEnvApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  const mapping: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    inceptionlabs: 'INCEPTION_API_KEY',
  };
  for (const [prov, envVar] of Object.entries(mapping)) {
    const value = process.env[envVar];
    if (value) keys[prov] = value;
  }
  return keys;
}
