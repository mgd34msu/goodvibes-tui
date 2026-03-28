/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all types from the new config system
 * - Backward-compatible `AppConfig` interface and `config` singleton
 *   so all existing `import { config } from '../config/index.ts'` usages work
 */

export { ConfigManager } from './manager.ts';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from './schema.ts';
export { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.ts';
export { ConfigError } from '../types/errors.ts';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.ts';
import type { GoodVibesConfig } from './schema.ts';
import { logger } from '../utils/logger.ts';
import { getSecretsManager } from './secrets.ts';

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
    const manager = getConfigManager();
    // Proxy handler requires untyped index access — TypeScript does not allow
    // bracket-notation on a typed class, so we cast through Record to read any
    // property by string/symbol at runtime.
    const value = (manager as unknown as Record<string | symbol, unknown>)[prop];
    // Bind methods to the singleton so `this` is correct when called via the proxy.
    if (typeof value === 'function') {
      // `as Function` is the narrowest safe cast here; we just need .bind().
      return (value as Function).bind(manager);
    }
    return value;
  },
  set(_target, prop: string | symbol, value: unknown) {
    // Same rationale as the getter: runtime property assignment via bracket notation.
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
    openrouter: 'OPENROUTER_API_KEY',
    aihubmix: 'AIHUBMIX_API_KEY',
    groq: 'GROQ_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    'ollama-cloud': 'OLLAMA_CLOUD_API_KEY',
    // Note: also checked as OLLAMA_API_KEY below
    huggingface: 'HF_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    llm7: 'LLM7_API_KEY',
  };
  for (const [prov, envVar] of Object.entries(mapping)) {
    let value = process.env[envVar];
    // Fallback env var names
    if (!value && prov === 'gemini') value = process.env['GOOGLE_API_KEY'] ?? process.env['GOOGLE_GEMINI_API_KEY'];
    if (!value && prov === 'openai') value = process.env['OPENAI_KEY'];
    if (!value && prov === 'anthropic') value = process.env['CLAUDE_API_KEY'];
    if (!value && prov === 'ollama-cloud') value = process.env['OLLAMA_API_KEY'];
    if (!value && prov === 'huggingface') value = process.env['HUGGINGFACE_API_KEY'] ?? process.env['HF_TOKEN'];
    if (value) keys[prov] = value;
  }
  return keys;
}

/**
 * resolveApiKeys — three-tier async resolution for all provider API keys.
 *
 * Resolution order per key:
 *   1. Environment variable (process.env)
 *   2. SecretsManager encrypted store (.goodvibes/tui/secrets.enc)
 *   3. Omitted from result (null → skip)
 *
 * Returns a map of provider → apiKey for all providers where a key is found.
 */
export async function resolveApiKeys(): Promise<Record<string, string>> {
  const secrets = getSecretsManager();
  const mapping: Array<{ prov: string; envVars: string[] }> = [
    { prov: 'openai',       envVars: ['OPENAI_API_KEY', 'OPENAI_KEY'] },
    { prov: 'anthropic',    envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'] },
    { prov: 'gemini',       envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'] },
    { prov: 'inceptionlabs', envVars: ['INCEPTION_API_KEY'] },
    { prov: 'openrouter',    envVars: ['OPENROUTER_API_KEY'] },
    { prov: 'aihubmix',     envVars: ['AIHUBMIX_API_KEY'] },
    { prov: 'groq',          envVars: ['GROQ_API_KEY'] },
    { prov: 'cerebras',      envVars: ['CEREBRAS_API_KEY'] },
    { prov: 'mistral',       envVars: ['MISTRAL_API_KEY'] },
    { prov: 'ollama-cloud',  envVars: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'] },
    { prov: 'huggingface',   envVars: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
    { prov: 'nvidia',        envVars: ['NVIDIA_API_KEY'] },
    { prov: 'llm7',          envVars: ['LLM7_API_KEY'] },
  ];

  const result: Record<string, string> = {};

  for (const { prov, envVars } of mapping) {
    // Tier 1: environment variables
    let value: string | null = null;
    for (const envVar of envVars) {
      if (process.env[envVar]) {
        value = process.env[envVar]!;
        break;
      }
    }

    // Tier 2: SecretsManager encrypted store
    if (value === null) {
      for (const envVar of envVars) {
        const stored = await secrets.get(envVar);
        if (stored !== null) {
          value = stored;
          break;
        }
      }
    }

    if (value !== null) {
      result[prov] = value;
    }
  }

  return result;
}
