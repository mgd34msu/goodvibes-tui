/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Pure helpers that derive values from an explicit ConfigManager instance
 */

export { ConfigManager } from './manager.ts';
export type { DeepReadonly } from './manager.ts';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from './schema.ts';
export { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.ts';
export { ConfigError } from '../types/errors.ts';

import { readFileSync } from 'fs';
import { ConfigManager } from './manager.ts';
import type { GoodVibesConfig } from './schema.ts';
import { SecretsManager } from './secrets.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.provider');
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
}

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

export function getConfiguredSystemPrompt(configManager: Pick<ConfigManager, 'get'>): string | undefined {
  const file = configManager.get('provider.systemPromptFile');
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    logger.debug('systemPrompt file read failed (non-fatal)', { file, error: summarizeError(err) });
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
    deepseek: 'DEEPSEEK_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    'github-copilot': 'COPILOT_GITHUB_TOKEN',
    'microsoft-foundry': 'AZURE_OPENAI_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
    qianfan: 'QIANFAN_API_KEY',
    qwen: 'QWEN_API_KEY',
    sglang: 'SGLANG_API_KEY',
    stepfun: 'STEPFUN_API_KEY',
    together: 'TOGETHER_API_KEY',
    venice: 'VENICE_API_KEY',
    volcengine: 'VOLCANO_ENGINE_API_KEY',
    xai: 'XAI_API_KEY',
    xiaomi: 'XIAOMI_API_KEY',
    zai: 'ZAI_API_KEY',
    'cloudflare-ai-gateway': 'CLOUDFLARE_AI_GATEWAY_API_KEY',
    'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
    litellm: 'LITELLM_API_KEY',
    'copilot-proxy': 'COPILOT_PROXY_API_KEY',
  };
  for (const [prov, envVar] of Object.entries(mapping)) {
    let value = process.env[envVar];
    // Fallback env var names
    if (!value && prov === 'gemini') value = process.env['GOOGLE_API_KEY'] ?? process.env['GOOGLE_GEMINI_API_KEY'];
    if (!value && prov === 'openai') value = process.env['OPENAI_KEY'];
    if (!value && prov === 'anthropic') value = process.env['CLAUDE_API_KEY'];
    if (!value && prov === 'ollama-cloud') value = process.env['OLLAMA_API_KEY'];
    if (!value && prov === 'huggingface') value = process.env['HUGGINGFACE_API_KEY'] ?? process.env['HF_TOKEN'];
    if (!value && prov === 'github-copilot') value = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
    if (!value && prov === 'qwen') value = process.env['DASHSCOPE_API_KEY'] ?? process.env['MODELSTUDIO_API_KEY'];
    if (!value && prov === 'zai') value = process.env['Z_AI_API_KEY'];
    if (value) keys[prov] = value;
  }
  return keys;
}

/**
 * resolveApiKeys — three-tier async resolution for all provider API keys.
 *
 * Resolution order per key:
 *   1. Environment variable (process.env)
 *   2. SecretsManager hierarchy-aware stores (secure preferred, plaintext policy-aware)
 *   3. Omitted from result (null → skip)
 *
 * Returns a map of provider → apiKey for all providers where a key is found.
 */
export async function resolveApiKeys(
  secrets: Pick<SecretsManager, 'get'>,
): Promise<Record<string, string>> {
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
    { prov: 'deepseek',      envVars: ['DEEPSEEK_API_KEY'] },
    { prov: 'fireworks',     envVars: ['FIREWORKS_API_KEY'] },
    { prov: 'github-copilot', envVars: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] },
    { prov: 'microsoft-foundry', envVars: ['AZURE_OPENAI_API_KEY'] },
    { prov: 'minimax',       envVars: ['MINIMAX_API_KEY'] },
    { prov: 'moonshot',      envVars: ['MOONSHOT_API_KEY'] },
    { prov: 'qianfan',       envVars: ['QIANFAN_API_KEY'] },
    { prov: 'qwen',          envVars: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'] },
    { prov: 'sglang',        envVars: ['SGLANG_API_KEY'] },
    { prov: 'stepfun',       envVars: ['STEPFUN_API_KEY'] },
    { prov: 'together',      envVars: ['TOGETHER_API_KEY'] },
    { prov: 'venice',        envVars: ['VENICE_API_KEY'] },
    { prov: 'volcengine',    envVars: ['VOLCANO_ENGINE_API_KEY'] },
    { prov: 'xai',           envVars: ['XAI_API_KEY'] },
    { prov: 'xiaomi',        envVars: ['XIAOMI_API_KEY'] },
    { prov: 'zai',           envVars: ['ZAI_API_KEY', 'Z_AI_API_KEY'] },
    { prov: 'cloudflare-ai-gateway', envVars: ['CLOUDFLARE_AI_GATEWAY_API_KEY'] },
    { prov: 'vercel-ai-gateway', envVars: ['AI_GATEWAY_API_KEY'] },
    { prov: 'litellm',       envVars: ['LITELLM_API_KEY'] },
    { prov: 'copilot-proxy', envVars: ['COPILOT_PROXY_API_KEY'] },
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

    // Tier 2: SecretsManager hierarchy-aware secure/plaintext stores
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
