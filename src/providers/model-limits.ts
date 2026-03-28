/**
 * model-limits.ts
 *
 * Fetches, caches, and resolves per-model token limits.
 * Data source: OpenRouter public API (no auth required).
 * Cache: ~/.goodvibes/tui/model-limits.json (24hr TTL).
 *
 * Public API:
 *   getTokenLimitsForModel(modelDef)  — resolve limits for a model
 *   getToolResultMaxChars()           — current model's tool result char limit
 *   refreshModelLimits()              — force fetch from OpenRouter, returns count
 *   initModelLimits()                 — sync cache load + background refresh if stale
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { ModelDefinition, TokenLimits } from './registry.ts';
import { getProviderRegistry } from './registry.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterModelData {
  id: string;
  context_length: number;
  top_provider: {
    max_completion_tokens: number | null;
  };
  supported_parameters?: string[];
  pricing?: {
    prompt: string;       // USD per token as string, e.g. "0.0000001"
    completion: string;   // USD per token as string
  };
}

interface OpenRouterResponse {
  data: OpenRouterModelData[];
}

interface ModelLimitsCache {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: Record<string, {
    contextLength: number;
    maxOutputTokens: number | null;
    supportedParameters: string[];
    pricing?: { prompt: number; completion: number }; // USD per token
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 86_400_000; // 24 hours

const DEFAULT_TOKEN_LIMITS: Required<TokenLimits> = {
  maxOutputTokens: 8192,
  maxToolResultTokens: 50_000,
  maxToolCalls: 128,
  maxReasoningTokens: 16384,
};

// ---------------------------------------------------------------------------
// Cache path
// ---------------------------------------------------------------------------

function getCachePath(): string {
  return join(homedir(), '.goodvibes', 'tui', 'model-limits.json');
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let cachedData: ModelLimitsCache | null = null;
let cachedOrMap: Map<string, OpenRouterModelData> | null = null;

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

function loadCachedLimits(): ModelLimitsCache | null {
  try {
    const raw = readFileSync(getCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as ModelLimitsCache;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    // Distinguish missing file (expected) from corrupted cache (worth warning about)
    const msg = String(err);
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      logger.debug('[model-limits] No cache file found (first run)');
    } else {
      logger.warn('[model-limits] Cache load failed (corrupted?)', { error: msg });
    }
    return null;
  }
}

function saveCachedLimits(cache: ModelLimitsCache): void {
  try {
    const dir = join(homedir(), '.goodvibes', 'tui');
    mkdirSync(dir, { recursive: true });
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.debug('[model-limits] Cache write failed', { error: String(err) });
  }
}

function isCacheStale(cache: ModelLimitsCache): boolean {
  return Date.now() - cache.fetchedAt > cache.ttlMs;
}

// ---------------------------------------------------------------------------
// OpenRouter fetch
// ---------------------------------------------------------------------------

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelData>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}`);
    }

    const json = await response.json() as OpenRouterResponse;
    const map = new Map<string, OpenRouterModelData>();

    if (Array.isArray(json.data)) {
      for (const model of json.data) {
        if (typeof model.id === 'string') {
          map.set(model.id, model);
        }
      }
    }

    return map;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Model ID matching
// ---------------------------------------------------------------------------

/**
 * Strip date/version suffixes from a model ID to get a fuzzy stem.
 * e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4"
 *      "gpt-4.1-mini-2025" → "gpt-4.1-mini"
 */
function getModelStem(modelId: string): string {
  // Remove trailing date stamps: -YYYYMMDD or -YYMM
  return modelId
    .replace(/-\d{8}$/, '')     // -20250514
    .replace(/-(?:2[4-9]|3[0-9])\d{2}$/, '')  // -2512 (YYMM where YY is 24-39)
    .replace(/-\d{6}$/, '');    // -202512
}

function findOpenRouterMatch(
  modelId: string,
  provider: string,
  orModels: Map<string, OpenRouterModelData>,
): OpenRouterModelData | null {
  // 1. Exact match
  if (orModels.has(modelId)) {
    return orModels.get(modelId)!;
  }

  // 2. Provider-prefixed match
  const prefixed = `${provider}/${modelId}`;
  if (orModels.has(prefixed)) {
    return orModels.get(prefixed)!;
  }

  // 3. Fuzzy stem match: strip date suffixes, try with provider prefix
  const stem = getModelStem(modelId);
  if (stem !== modelId) {
    // Try exact stem
    if (orModels.has(stem)) return orModels.get(stem)!;
    // Try provider-prefixed stem
    const prefixedStem = `${provider}/${stem}`;
    if (orModels.has(prefixedStem)) return orModels.get(prefixedStem)!;
  }

  // 4. Partial suffix match: find any OR model whose ID ends with the stem
  for (const [orId, orModel] of orModels) {
    if (orId.endsWith(`/${stem}`) || orId.endsWith(`/${modelId}`)) {
      return orModel;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve token limits for a model definition.
 * Priority (highest to lowest):
 *   1. modelDef.tokenLimits (explicit builtin overrides)
 *   2. providerLimits (from scanner/provider API)
 *   3. OpenRouter cache data
 *   4. Sensible defaults
 */
function resolveTokenLimits(
  modelDef: ModelDefinition,
  providerLimits?: Partial<TokenLimits>,
): Required<TokenLimits> {
  const result: Required<TokenLimits> = { ...DEFAULT_TOKEN_LIMITS };

  // Apply OpenRouter cached data if available
  if (cachedData) {
    const orMap = cachedOrMap ?? buildOrMap(cachedData);
    const orMatch = findOpenRouterMatch(
      modelDef.id,
      modelDef.provider,
      orMap,
    );
    if (orMatch?.top_provider?.max_completion_tokens != null) {
      result.maxOutputTokens = orMatch.top_provider.max_completion_tokens;
    }
  }

  // Apply provider-specific overrides (from scanner/cloud provider)
  if (providerLimits) {
    if (providerLimits.maxOutputTokens != null) result.maxOutputTokens = providerLimits.maxOutputTokens;
    if (providerLimits.maxToolResultTokens != null) result.maxToolResultTokens = providerLimits.maxToolResultTokens;
    if (providerLimits.maxToolCalls != null) result.maxToolCalls = providerLimits.maxToolCalls;
    if (providerLimits.maxReasoningTokens != null) result.maxReasoningTokens = providerLimits.maxReasoningTokens;
  }

  // Apply explicit modelDef overrides (highest priority)
  const explicit = modelDef.tokenLimits;
  if (explicit) {
    if (explicit.maxOutputTokens != null) result.maxOutputTokens = explicit.maxOutputTokens;
    if (explicit.maxToolResultTokens != null) result.maxToolResultTokens = explicit.maxToolResultTokens;
    if (explicit.maxToolCalls != null) result.maxToolCalls = explicit.maxToolCalls;
    if (explicit.maxReasoningTokens != null) result.maxReasoningTokens = explicit.maxReasoningTokens;
  }

  return result;
}

/** Build an OR map from the cache for matching. */
function buildOrMap(cache: ModelLimitsCache): Map<string, OpenRouterModelData> {
  const map = new Map<string, OpenRouterModelData>();
  for (const [id, entry] of Object.entries(cache.models)) {
    map.set(id, {
      id,
      context_length: entry.contextLength,
      top_provider: { max_completion_tokens: entry.maxOutputTokens },
      supported_parameters: entry.supportedParameters,
      pricing: entry.pricing
        ? { prompt: String(entry.pricing.prompt), completion: String(entry.pricing.completion) }
        : undefined,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up pricing for a model from the OpenRouter cache.
 * Returns USD per token (not per million) for prompt and completion.
 * Returns null if no pricing data is available.
 */
export function getPricingForModel(
  modelId: string,
  provider: string,
): { prompt: number; completion: number } | null {
  if (!cachedData) return null;
  const orMap = cachedOrMap ?? buildOrMap(cachedData);
  const match = findOpenRouterMatch(modelId, provider, orMap);
  if (!match?.pricing) return null;
  const prompt = parseFloat(match.pricing.prompt);
  const completion = parseFloat(match.pricing.completion);
  if (isNaN(prompt) || isNaN(completion)) return null;
  return { prompt, completion };
}

/**
 * Resolve token limits for a model definition using current in-memory cache.
 */
export function getTokenLimitsForModel(modelDef: ModelDefinition): Required<TokenLimits> {
  return resolveTokenLimits(modelDef);
}

/**
 * Resolve the effective context window for a model.
 * Priority (highest to lowest):
 *   1. OpenRouter cached context_length (most accurate, updated from API)
 *   2. modelDef.contextWindow (static registry value, always present)
 */
export function getContextWindowForModel(modelDef: ModelDefinition): number {
  if (cachedData) {
    const orMap = cachedOrMap ?? buildOrMap(cachedData);
    const orMatch = findOpenRouterMatch(modelDef.id, modelDef.provider, orMap);
    if (orMatch?.context_length != null && orMatch.context_length > 0) {
      return orMatch.context_length;
    }
  }
  return modelDef.contextWindow;
}

/**
 * Get the max chars for tool results based on the current model.
 * Falls back to 50_000 if registry is unavailable.
 */
export function getToolResultMaxChars(): number {
  try {
    const registry = getProviderRegistry();
    const model = registry.getCurrentModel();
    return resolveTokenLimits(model).maxToolResultTokens;
  } catch (err) {
    logger.debug('[model-limits] getToolResultMaxChars fallback to default', { error: String(err) });
    return DEFAULT_TOKEN_LIMITS.maxToolResultTokens;
  }
}

/**
 * Force fetch fresh data from OpenRouter, update cache and in-memory state.
 * Returns the number of models updated.
 */
export async function refreshModelLimits(): Promise<number> {
  const orModels = await fetchOpenRouterModels();

  const models: ModelLimitsCache['models'] = {};
  for (const [id, model] of orModels) {
    let pricing: { prompt: number; completion: number } | undefined;
    if (model.pricing?.prompt != null && model.pricing?.completion != null) {
      const prompt = parseFloat(model.pricing.prompt);
      const completion = parseFloat(model.pricing.completion);
      if (!isNaN(prompt) && !isNaN(completion)) {
        pricing = { prompt, completion };
      }
    }
    models[id] = {
      contextLength: model.context_length ?? 0,
      maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
      supportedParameters: model.supported_parameters ?? [],
      pricing,
    };
  }

  const newCache: ModelLimitsCache = {
    version: 1,
    fetchedAt: Date.now(),
    ttlMs: CACHE_TTL_MS,
    models,
  };

  saveCachedLimits(newCache);
  cachedData = newCache;
  cachedOrMap = buildOrMap(newCache);

  return orModels.size;
}

/**
 * Synchronously load cache from disk; trigger background refresh if stale.
 * Safe to call from main.ts startup — never blocks.
 */
export function initModelLimits(): void {
  cachedData = loadCachedLimits();
  if (cachedData) {
    cachedOrMap = buildOrMap(cachedData);
  }

  if (!cachedData || isCacheStale(cachedData)) {
    // Background refresh — do not await
    refreshModelLimits().catch((err) => {
      logger.debug('[model-limits] Background refresh failed', { error: String(err) });
    });
  }
}
