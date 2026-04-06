/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Lazy singleton accessors for runtime configuration and derived helpers
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

/** Lazy singleton — initialized on first access to avoid sync I/O at import time. */
let _configManager: ConfigManager | undefined;
export function getConfigManager(): ConfigManager {
  if (!_configManager) _configManager = new ConfigManager();
  return _configManager;
}

export function _resetConfigManagerForTesting(): void {
  _configManager = undefined;
}

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

export function getConfigSnapshot(): Readonly<GoodVibesConfig> {
  return getConfigManager().getRaw();
}

export function getConfiguredModelId(): string {
  return getConfigSnapshot().provider.model;
}

export function getConfiguredProviderId(): string {
  return getConfigSnapshot().provider.provider;
}

export function isAutoApproveEnabled(): boolean {
  return getConfigSnapshot().behavior.autoApprove;
}

export function getWorkingDirectory(): string {
  return process.cwd();
}

export function getConfiguredSystemPrompt(): string | undefined {
  const file = getConfigSnapshot().provider.systemPromptFile;
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    logger.debug('systemPrompt file read failed (non-fatal)', { file, error: String(err) });
    return undefined;
  }
}

export function getConfiguredApiKeys(): Record<string, string> {
  return loadEnvApiKeys();
}

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
