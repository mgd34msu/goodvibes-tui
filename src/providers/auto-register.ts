/**
 * auto-register.ts
 *
 * Automatically registers providers when their API keys are detected in the environment.
 *
 * When a user has an API key set in their environment (e.g. GROQ_API_KEY),
 * auto-register that provider using catalog data — zero manual configuration.
 *
 * Multi-endpoint providers (e.g. ZenMux) are handled by registering separate
 * provider instances for each endpoint, routed by the model's native API format.
 */

import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicCompatProvider } from './anthropic-compat.ts';
import type { LLMProvider } from './interface.ts';
import { getProviderRegistry } from './registry.ts';
import { hasKeyForProvider } from './model-catalog.ts';
import type { CatalogProvider } from './model-catalog.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** API wire format used by a provider endpoint. */
export type ApiFormat = 'openai' | 'anthropic';

/**
 * Extended provider descriptor used internally for auto-registration.
 * Extends CatalogProvider with routing metadata.
 */
export interface AutoRegisterEntry extends CatalogProvider {
  /**
   * Wire format used by this endpoint.
   * Defaults to 'openai' (OpenAI-compatible).
   */
  apiFormat?: ApiFormat;
  /**
   * Default model ID sent when no model is specified in a request.
   * Auto-register uses the first entry from the catalog where available;
   * falls back to this value.
   */
  defaultModel: string;
  /**
   * Model IDs pre-seeded for this provider.
   * Auto-registered providers start with an empty list; these seeds allow the
   * provider to be usable immediately without waiting for a catalog fetch.
   */
  seedModels?: string[];
}

// ---------------------------------------------------------------------------
// Catalog of auto-registerable providers
// ---------------------------------------------------------------------------

/**
 * Well-known providers that can be auto-registered from environment variables.
 *
 * Each entry maps to one registered LLM provider instance. Multi-endpoint
 * providers (e.g. ZenMux) appear multiple times — once per endpoint — with
 * distinct `id` and `name` values (e.g. 'zenmux' and 'zenmux-anthropic').
 *
 * Order determines registration priority when multiple providers offer the
 * same model. Earlier entries take precedence in the auto-registration log.
 */
export const AUTO_REGISTER_CATALOG: AutoRegisterEntry[] = [
  // -------------------------------------------------------------------------
  // Free / no-key-required providers
  // -------------------------------------------------------------------------
  {
    id: 'nvidia',
    name: 'NVIDIA',
    envVars: ['NVIDIA_API_KEY', 'NIM_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiFormat: 'openai',
    defaultModel: 'meta/llama-4-scout-17b-16e-instruct',
    seedModels: [
      'meta/llama-4-scout-17b-16e-instruct',
      'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      'moonshotai/kimi-k2-instruct',
    ],
  },

  // -------------------------------------------------------------------------
  // OpenAI-compatible paid providers
  // -------------------------------------------------------------------------
  {
    id: 'groq',
    name: 'Groq',
    envVars: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
    apiFormat: 'openai',
    defaultModel: 'qwen/qwen3-32b',
    seedModels: [
      'qwen/qwen3-32b',
      'moonshotai/kimi-k2-instruct',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    envVars: ['CEREBRAS_API_KEY'],
    baseUrl: 'https://api.cerebras.ai/v1',
    apiFormat: 'openai',
    defaultModel: 'qwen-3-235b-a22b-instruct-2507',
    seedModels: [
      'qwen-3-235b-a22b-instruct-2507',
      'llama3.1-8b',
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    envVars: ['TOGETHER_API_KEY'],
    baseUrl: 'https://api.together.xyz/v1',
    apiFormat: 'openai',
    defaultModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    seedModels: [
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'Qwen/Qwen3-235B-A22B-fp8-tput',
      'moonshotai/Kimi-K2-Instruct',
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    envVars: ['FIREWORKS_API_KEY'],
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiFormat: 'openai',
    defaultModel: 'accounts/fireworks/models/kimi-k2p5-turbo',
    seedModels: [
      'accounts/fireworks/models/kimi-k2p5-turbo',
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envVars: ['MISTRAL_API_KEY'],
    baseUrl: 'https://api.mistral.ai/v1',
    apiFormat: 'openai',
    defaultModel: 'mistral-large-latest',
    seedModels: [
      'mistral-large-latest',
      'codestral-latest',
      'mistral-small-latest',
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    envVars: ['COHERE_API_KEY', 'CO_API_KEY'],
    baseUrl: 'https://api.cohere.com/v2',
    apiFormat: 'openai',
    defaultModel: 'command-a-03-2025',
    seedModels: [
      'command-a-03-2025',
      'command-r-plus-08-2024',
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    envVars: ['DEEPINFRA_API_KEY'],
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiFormat: 'openai',
    defaultModel: 'moonshotai/Kimi-K2-Instruct',
    seedModels: [
      'moonshotai/Kimi-K2-Instruct',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    ],
  },
  {
    id: 'huggingface',
    name: 'HuggingFace',
    envVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY', 'HUGGING_FACE_HUB_TOKEN'],
    baseUrl: 'https://api-inference.huggingface.co/v1',
    apiFormat: 'openai',
    defaultModel: 'Qwen/Qwen3-235B-A22B',
    seedModels: [
      'Qwen/Qwen3-235B-A22B',
      'moonshotai/Kimi-K2-Instruct',
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    envVars: ['XAI_API_KEY'],
    baseUrl: 'https://api.x.ai/v1',
    apiFormat: 'openai',
    defaultModel: 'grok-4',
    seedModels: [
      'grok-4',
      'grok-3-mini',
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    envVars: ['PERPLEXITY_API_KEY'],
    baseUrl: 'https://api.perplexity.ai',
    apiFormat: 'openai',
    defaultModel: 'sonar-pro',
    seedModels: [
      'sonar-pro',
      'sonar',
      'r1-1776',
    ],
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    envVars: ['SAMBANOVA_API_KEY'],
    baseUrl: 'https://fast-api.snova.ai/v1',
    apiFormat: 'openai',
    defaultModel: 'Llama-4-Maverick-17B-128E-Instruct',
    seedModels: [
      'Llama-4-Maverick-17B-128E-Instruct',
      'Meta-Llama-3.3-70B-Instruct',
    ],
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    envVars: ['OPENCODE_ZEN_API_KEY', 'ZEN_API_KEY'],
    baseUrl: 'https://zenmux.ai/api/v1',
    apiFormat: 'openai',
    defaultModel: 'kimi-k2.5-free',
    seedModels: [
      'kimi-k2.5-free',
      'gpt-oss-120b-free',
    ],
  },

  // -------------------------------------------------------------------------
  // ZenMux: multi-endpoint provider
  // OpenAI-compatible endpoint (primary)
  // -------------------------------------------------------------------------
  {
    id: 'zenmux',
    name: 'ZenMux',
    envVars: ['ZENMUX_API_KEY'],
    baseUrl: 'https://zenmux.ai/api/v1',
    apiFormat: 'openai',
    defaultModel: 'gpt-5.4',
    seedModels: [
      'gpt-5.4',
      'gpt-5-mini',
      'kimi-k2-instruct',
    ],
  },
  // ZenMux: Anthropic-compatible endpoint (secondary)
  {
    id: 'zenmux-anthropic',
    name: 'ZenMux (Anthropic)',
    envVars: ['ZENMUX_API_KEY'],
    baseUrl: 'https://zenmux.ai/api/anthropic/v1',
    apiFormat: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    seedModels: [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
  },

  // -------------------------------------------------------------------------
  // Ollama Cloud / self-hosted
  // -------------------------------------------------------------------------
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    envVars: ['OLLAMA_API_KEY', 'OLLAMA_HOST'],
    baseUrl: 'https://ollama.com/api',
    apiFormat: 'openai',
    defaultModel: 'llama3.3',
    seedModels: [
      'llama3.3',
      'qwen3:32b',
    ],
  },
];

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Check whether a provider ID is already registered in the provider registry.
 * Uses try/catch since ProviderRegistry.get() throws on missing providers.
 *
 * @internal Exported for testing.
 */
export function isProviderRegistered(providerId: string): boolean {
  try {
    getProviderRegistry().get(providerId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the API key to use for a provider entry.
 * Returns the first non-empty env var value, or empty string.
 *
 * @internal Exported for testing.
 */
export function resolveApiKey(entry: AutoRegisterEntry): string {
  for (const varName of entry.envVars) {
    const val = process.env[varName];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return '';
}

/**
 * Create an LLMProvider instance from an AutoRegisterEntry.
 * Routes to the correct provider class based on apiFormat.
 *
 * @internal Exported for testing.
 */
export function createProviderFromEntry(entry: AutoRegisterEntry, apiKey: string): LLMProvider {
  const models = entry.seedModels ?? [entry.defaultModel];

  if (entry.apiFormat === 'anthropic') {
    return new AnthropicCompatProvider({
      name: entry.id,
      baseURL: entry.baseUrl,
      apiKey,
      defaultModel: entry.defaultModel,
      models,
    });
  }

  // Default: OpenAI-compatible
  return new OpenAICompatProvider({
    name: entry.id,
    baseURL: entry.baseUrl,
    apiKey,
    defaultModel: entry.defaultModel,
    models,
    reasoningFormat: 'none',
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * autoRegisterProviders — scan catalog providers, check env vars, register
 * any providers not already in the registry.
 *
 * Called during startup after `initCatalog()`. Safe to call multiple times;
 * already-registered providers are skipped.
 *
 * @param catalog - Optional override for the provider catalog entries.
 *   Defaults to AUTO_REGISTER_CATALOG. Pass a custom list in tests.
 * @returns Array of display names that were newly registered.
 *
 * @example
 * // Startup sequence:
 * // const names = autoRegisterProviders();
 * // if (names.length > 0) {
 * //   conversation.addSystemMessage(`Auto-registered ${names.length} providers: ${names.join(', ')}`);
 * // }
 */
export function autoRegisterProviders(
  catalog: AutoRegisterEntry[] = AUTO_REGISTER_CATALOG,
): string[] {
  const registered: string[] = [];

  for (const entry of catalog) {
    // Skip if env var not set (no key available)
    if (!hasKeyForProvider(entry)) {
      continue;
    }

    // Skip if provider is already registered (built-in or previously auto-registered)
    if (isProviderRegistered(entry.id)) {
      continue;
    }

    const apiKey = resolveApiKey(entry);

    try {
      const provider = createProviderFromEntry(entry, apiKey);
      getProviderRegistry().register(provider);
      registered.push(entry.name);
    } catch (err) {
      logger.warn('[auto-register] Failed to register', { name: entry.name, error: String(err) });
    }
  }

  if (registered.length > 0) {
    logger.info('[auto-register] Auto-registered', { count: registered.length, providers: registered.join(', ') });
  }

  return registered;
}

