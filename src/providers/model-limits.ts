import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ModelDefinition, TokenLimits } from './registry.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

interface OpenRouterModelData {
  id: string;
  context_length: number;
  top_provider: {
    max_completion_tokens: number | null;
  };
  supported_parameters?: string[];
  pricing?: {
    prompt: string;
    completion: string;
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
    pricing?: { prompt: number; completion: number };
  }>;
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 86_400_000;

const DEFAULT_TOKEN_LIMITS: Required<TokenLimits> = {
  maxOutputTokens: 8192,
  maxToolResultTokens: 50_000,
  maxToolCalls: 128,
  maxReasoningTokens: 16384,
};

export interface ModelLimitsServiceOptions {
  readonly cachePath: string;
}

export function getModelLimitsCachePath(cacheDir: string): string {
  return join(cacheDir, 'model-limits.json');
}

function loadCachedLimits(cachePath: string): ModelLimitsCache | null {
  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as ModelLimitsCache;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (error) {
    const message = summarizeError(error);
    if (message.includes('ENOENT') || message.includes('no such file')) {
      logger.debug('[model-limits] No cache file found (first run)');
    } else {
      logger.warn('[model-limits] Cache load failed (corrupted?)', { error: message });
    }
    return null;
  }
}

function saveCachedLimits(cache: ModelLimitsCache, cachePath: string): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    logger.debug('[model-limits] Cache write failed', { error: summarizeError(error) });
  }
}

function isCacheStale(cache: ModelLimitsCache): boolean {
  return Date.now() - cache.fetchedAt > cache.ttlMs;
}

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelData>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
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

function getModelStem(modelId: string): string {
  return modelId
    .replace(/-\d{8}$/, '')
    .replace(/-(?:2[4-9]|3[0-9])\d{2}$/, '')
    .replace(/-\d{6}$/, '');
}

function findOpenRouterMatch(
  modelId: string,
  provider: string,
  orModels: Map<string, OpenRouterModelData>,
): OpenRouterModelData | null {
  if (orModels.has(modelId)) return orModels.get(modelId) ?? null;

  const prefixed = `${provider}/${modelId}`;
  if (orModels.has(prefixed)) return orModels.get(prefixed) ?? null;

  const stem = getModelStem(modelId);
  if (stem !== modelId) {
    if (orModels.has(stem)) return orModels.get(stem) ?? null;
    const prefixedStem = `${provider}/${stem}`;
    if (orModels.has(prefixedStem)) return orModels.get(prefixedStem) ?? null;
  }

  for (const [orId, orModel] of orModels) {
    if (orId.endsWith(`/${stem}`) || orId.endsWith(`/${modelId}`)) {
      return orModel;
    }
  }

  return null;
}

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

export class ModelLimitsService {
  private cachedData: ModelLimitsCache | null = null;
  private cachedOrMap: Map<string, OpenRouterModelData> | null = null;

  constructor(private readonly options: ModelLimitsServiceOptions) {}

  private ensureOpenRouterMap(): Map<string, OpenRouterModelData> | null {
    if (!this.cachedData) return null;
    if (!this.cachedOrMap) {
      this.cachedOrMap = buildOrMap(this.cachedData);
    }
    return this.cachedOrMap;
  }

  private resolveTokenLimits(
    modelDef: ModelDefinition,
    providerLimits?: Partial<TokenLimits>,
  ): Required<TokenLimits> {
    const result: Required<TokenLimits> = { ...DEFAULT_TOKEN_LIMITS };
    const orMap = this.ensureOpenRouterMap();
    if (orMap) {
      const orMatch = findOpenRouterMatch(modelDef.id, modelDef.provider, orMap);
      if (orMatch?.top_provider?.max_completion_tokens != null) {
        result.maxOutputTokens = orMatch.top_provider.max_completion_tokens;
      }
    }
    if (providerLimits) {
      if (providerLimits.maxOutputTokens != null) result.maxOutputTokens = providerLimits.maxOutputTokens;
      if (providerLimits.maxToolResultTokens != null) result.maxToolResultTokens = providerLimits.maxToolResultTokens;
      if (providerLimits.maxToolCalls != null) result.maxToolCalls = providerLimits.maxToolCalls;
      if (providerLimits.maxReasoningTokens != null) result.maxReasoningTokens = providerLimits.maxReasoningTokens;
    }
    const explicit = modelDef.tokenLimits;
    if (explicit) {
      if (explicit.maxOutputTokens != null) result.maxOutputTokens = explicit.maxOutputTokens;
      if (explicit.maxToolResultTokens != null) result.maxToolResultTokens = explicit.maxToolResultTokens;
      if (explicit.maxToolCalls != null) result.maxToolCalls = explicit.maxToolCalls;
      if (explicit.maxReasoningTokens != null) result.maxReasoningTokens = explicit.maxReasoningTokens;
    }
    return result;
  }

  getPricingForModel(modelId: string, provider: string): { prompt: number; completion: number } | null {
    const orMap = this.ensureOpenRouterMap();
    if (!orMap) return null;
    const match = findOpenRouterMatch(modelId, provider, orMap);
    if (!match?.pricing) return null;
    const prompt = parseFloat(match.pricing.prompt);
    const completion = parseFloat(match.pricing.completion);
    if (Number.isNaN(prompt) || Number.isNaN(completion)) return null;
    return { prompt, completion };
  }

  getTokenLimitsForModel(modelDef: ModelDefinition): Required<TokenLimits> {
    return this.resolveTokenLimits(modelDef);
  }

  getContextWindowForModel(modelDef: ModelDefinition): number {
    if (modelDef.contextWindowProvenance === 'provider_api' && modelDef.contextWindow > 0) {
      return modelDef.contextWindow;
    }
    const orMap = this.ensureOpenRouterMap();
    if (orMap) {
      const orMatch = findOpenRouterMatch(modelDef.id, modelDef.provider, orMap);
      if (orMatch?.context_length != null && orMatch.context_length > 0) {
        return orMatch.context_length;
      }
    }
    return modelDef.contextWindow;
  }

  getToolResultMaxCharsForModel(model: ModelDefinition | null | undefined): number {
    if (!model) return DEFAULT_TOKEN_LIMITS.maxToolResultTokens;
    return this.resolveTokenLimits(model).maxToolResultTokens;
  }

  async refresh(): Promise<number> {
    const orModels = await fetchOpenRouterModels();
    const models: ModelLimitsCache['models'] = {};
    for (const [id, model] of orModels) {
      let pricing: { prompt: number; completion: number } | undefined;
      if (model.pricing?.prompt != null && model.pricing?.completion != null) {
        const prompt = parseFloat(model.pricing.prompt);
        const completion = parseFloat(model.pricing.completion);
        if (!Number.isNaN(prompt) && !Number.isNaN(completion)) {
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

    saveCachedLimits(newCache, this.options.cachePath);
    this.cachedData = newCache;
    this.cachedOrMap = buildOrMap(newCache);
    return orModels.size;
  }

  init(): void {
    this.cachedData = loadCachedLimits(this.options.cachePath);
    this.cachedOrMap = this.cachedData ? buildOrMap(this.cachedData) : null;
    if (!this.cachedData || isCacheStale(this.cachedData)) {
      void this.refresh().catch((error) => {
        logger.debug('[model-limits] Background refresh failed', { error: summarizeError(error) });
      });
    }
  }
}
