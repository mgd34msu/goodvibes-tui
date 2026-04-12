import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import type { CatalogModel } from './model-catalog.ts';

interface CatalogModelPricing {
  input: number;
  output: number;
}

interface CatalogProviderShape {
  id: string;
  name: string;
  env?: string[];
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

interface CatalogCacheFile {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: CatalogModel[];
}

interface ModelsDevModelCost {
  input?: number;
  output?: number;
}

interface ModelsDevModelLimit {
  context?: number;
  output?: number;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  cost?: ModelsDevModelCost;
  limit?: ModelsDevModelLimit;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  open_weights?: boolean;
}

type ModelsDevResponse = Record<string, CatalogProviderShape>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CATALOG_FETCH_TIMEOUT_MS = 30_000;
const CATALOG_TTL_MS = 86_400_000; // 24 hours

function getCatalogCachePath(): string {
  return join(homedir(), '.goodvibes', 'tui', 'model-catalog.json');
}

function getCatalogTmpPath(): string {
  return getCatalogCachePath() + '.tmp';
}

function categorizeProvider(providerId: string): 'subscription' | 'shutdown' | 'normal' {
  const subscriptionProviders = new Set([
    'github-copilot',
    'github-models',
    'v0',
    'vercel',
    'gitlab',
    'kimi-for-coding',
    'llama',
    'lmstudio',
  ]);
  const shutdownProviders = new Set(['iflow', 'iflowcn']);
  if (providerId.includes('coding-plan')) return 'subscription';
  if (subscriptionProviders.has(providerId)) return 'subscription';
  if (shutdownProviders.has(providerId)) return 'shutdown';
  return 'normal';
}

function isFreeModel(
  modelId: string,
  cost: ModelsDevModelCost | undefined,
  providerCategory: 'subscription' | 'shutdown' | 'normal',
): boolean {
  if (providerCategory === 'subscription') return false;
  if (modelId.includes('coding-plan')) return false;
  return (cost?.input ?? -1) === 0 && (cost?.output ?? -1) === 0;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function transformModelsDevResponse(json: ModelsDevResponse): CatalogModel[] {
  const models: CatalogModel[] = [];

  for (const [providerId, providerData] of Object.entries(json)) {
    if (!providerData || typeof providerData !== 'object') continue;

    const providerCategory = categorizeProvider(providerId);
    if (providerCategory === 'shutdown') continue;

    const providerName = String(providerData.name ?? providerId);
    const providerModels = providerData.models;
    if (!providerModels || typeof providerModels !== 'object') continue;

    for (const [modelKey, modelData] of Object.entries(providerModels)) {
      if (!modelData || typeof modelData !== 'object') continue;

      const modelId = String(modelData.id ?? modelKey);
      const modelName = String(modelData.name ?? modelId);
      const modelFamily = typeof modelData.family === 'string' ? modelData.family : undefined;
      const cost = modelData.cost;
      const limit = modelData.limit;
      const supportsReasoning = modelData.reasoning === true;

      const inputCost = typeof cost?.input === 'number' ? cost.input : 0;
      const outputCost = typeof cost?.output === 'number' ? cost.output : 0;
      const contextWindow = typeof limit?.context === 'number' ? limit.context : undefined;

      let tier: 'free' | 'paid' | 'subscription';
      if (providerCategory === 'subscription') {
        tier = 'subscription';
      } else if (isFreeModel(modelId, cost, providerCategory)) {
        tier = 'free';
      } else {
        tier = 'paid';
      }

      const maxOutputTokens = typeof limit?.output === 'number' ? limit.output : undefined;

      models.push({
        id: modelId,
        name: modelName,
        ...(modelFamily ? { family: modelFamily } : {}),
        provider: providerName,
        providerId,
        providerEnvVars: getStringArray(providerData.env),
        pricing: { input: inputCost, output: outputCost },
        tier,
        contextWindow,
        maxOutputTokens,
        ...(supportsReasoning ? { reasoning: true } : {}),
      });
    }
  }

  return models;
}

function loadCatalogCache(): CatalogCacheFile | null {
  try {
    const raw = fs.readFileSync(getCatalogCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as CatalogCacheFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch (err) {
    const msg = String(err);
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      logger.debug('[model-catalog] No cache file (first run)');
    } else {
      logger.warn('[model-catalog] Cache load failed', { error: msg });
    }
    return null;
  }
}

function saveCatalogCache(models: CatalogModel[]): void {
  try {
    const dir = join(homedir(), '.goodvibes', 'tui');
    fs.mkdirSync(dir, { recursive: true });
    const payload: CatalogCacheFile = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: CATALOG_TTL_MS,
      models,
    };
    const tmp = getCatalogTmpPath();
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, getCatalogCachePath());
  } catch (err) {
    logger.warn('[model-catalog] Cache write failed', { error: String(err) });
  }
}

function isCatalogCacheStale(cache: CatalogCacheFile): boolean {
  return Date.now() - cache.fetchedAt > cache.ttlMs;
}

/**
 * Fetch models.dev/api.json and parse into CatalogModel[].
 * Uses a 30-second timeout.
 */
export async function fetchCatalog(): Promise<CatalogModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`models.dev API returned ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as ModelsDevResponse;
    const models = transformModelsDevResponse(json);
    logger.debug('[model-catalog] Fetched models from models.dev', { count: models.length });
    return models;
  } finally {
    clearTimeout(timer);
  }
}

export {
  getCatalogCachePath,
  getCatalogTmpPath,
  loadCatalogCache,
  saveCatalogCache,
  isCatalogCacheStale,
};
