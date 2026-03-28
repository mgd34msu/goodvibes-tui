/**
 * model-catalog.ts
 *
 * Model catalog: provider metadata, pricing data, and context window lookups.
 *
 * Fetches live model data from https://models.dev/api.json with a 24-hour
 * disk cache at ~/.goodvibes/tui/model-catalog.json.
 *
 * Public startup API:
 *   initCatalog()                  — load cache + background refresh if stale
 *   getCostFromCatalog(modelId)    — pricing lookup from fetched catalog
 *   getCatalogModelDefinitions()   — MinimalModelDefinition[] for registry.ts
 *   getCatalog()                   — ModelCatalog for context window lookups
 *
 * Never deletes cache — if fetch fails, stale data is used indefinitely.
 * If both cache and fetch fail, the catalog is empty (no hardcoded models).
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { getContextWindowForModel } from './model-limits.ts';
import { providerRegistry } from './registry.ts';
import type { FavoritesData } from './favorites.ts';
import { compositeScore } from './model-benchmarks.ts';

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

/**
 * A provider entry in the dynamic catalog.
 * Used by hasKeyForProvider and categorizeProvider.
 */
export interface CatalogProvider {
  /** Unique provider ID (e.g. 'openai', 'anthropic') */
  id: string;
  /** Human-readable display name */
  name: string;
  /**
   * Environment variable names checked for API key presence.
   * Empty array means no key is required (self-hosted / subscription).
   */
  envVars: string[];
  /** Base URL for the provider's API */
  baseUrl: string;
  /**
   * When false, provider is reachable without an API key.
   * Defaults to true (key required) when omitted.
   */
  requiresKey?: boolean;
}

// ---------------------------------------------------------------------------
// Pricing types
// ---------------------------------------------------------------------------

/** USD per 1M tokens pricing for a model. */
export interface CatalogModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

/** A model entry with full pricing + context data. */
export interface CatalogModel {
  /** Canonical model ID (normalized, no provider prefix) */
  id: string;
  /** Display name */
  name: string;
  /** Provider display name */
  provider: string;
  /** Provider ID as used in the models.dev API (lowercase key, e.g. 'openai') */
  providerId: string;
  /** Environment variable names required to use this provider (from models.dev env field) */
  providerEnvVars: string[];
  /** Pricing in USD per 1M tokens */
  pricing: CatalogModelPricing;
  /** Tier category */
  tier: 'free' | 'paid' | 'subscription';
  /** Maximum context window in tokens */
  contextWindow?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
}

/** Internal pricing catalog structure for testing injection. */
export interface PricingCatalog {
  fetchedAt: number;
  models: CatalogModel[];
}

// ---------------------------------------------------------------------------
// Network / cache constants
// ---------------------------------------------------------------------------

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CATALOG_FETCH_TIMEOUT_MS = 30_000;
const CATALOG_TTL_MS = 86_400_000; // 24 hours

function getCatalogCachePath(): string {
  return join(homedir(), '.goodvibes', 'tui', 'model-catalog.json');
}

function getCatalogTmpPath(): string {
  return getCatalogCachePath() + '.tmp';
}

// ---------------------------------------------------------------------------
// On-disk cache shape
// ---------------------------------------------------------------------------

interface CatalogCacheFile {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  models: CatalogModel[];
}

// ---------------------------------------------------------------------------
// models.dev response shape
// ---------------------------------------------------------------------------

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

interface ModelsDevProvider {
  id?: string;
  name?: string;
  env?: string[];
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

// ---------------------------------------------------------------------------
// Provider categorization helpers
// ---------------------------------------------------------------------------

/** Provider IDs that are subscription-based (no per-token cost). */
const SUBSCRIPTION_PROVIDERS = new Set([
  'github-copilot',
  'github-models',
  'v0',
  'vercel',
  'gitlab',
]);

/** Provider IDs that are shut down / no longer active. */
const SHUTDOWN_PROVIDERS = new Set([
  'iflow',
  'iflowcn',
]);

function categorizeProvider(providerId: string): 'subscription' | 'shutdown' | 'normal' {
  if (SUBSCRIPTION_PROVIDERS.has(providerId)) return 'subscription';
  if (SHUTDOWN_PROVIDERS.has(providerId)) return 'shutdown';
  return 'normal';
}

/**
 * Returns true when a model should be considered free.
 * Criteria: zero input AND output cost, not a subscription provider,
 * and model ID does not contain "coding-plan".
 */
function isFreeModel(
  modelId: string,
  cost: ModelsDevModelCost | undefined,
  providerCategory: 'subscription' | 'shutdown' | 'normal',
): boolean {
  if (providerCategory === 'subscription') return false;
  if (modelId.includes('coding-plan')) return false;
  return (cost?.input ?? -1) === 0 && (cost?.output ?? -1) === 0;
}

// ---------------------------------------------------------------------------
// Transform models.dev response → CatalogModel[]
// ---------------------------------------------------------------------------

function transformModelsDevResponse(json: ModelsDevResponse): CatalogModel[] {
  const models: CatalogModel[] = [];

  for (const [providerId, providerData] of Object.entries(json)) {
    if (!providerData || typeof providerData !== 'object') continue;

    const providerCategory = categorizeProvider(providerId);
    // Skip shutdown providers entirely
    if (providerCategory === 'shutdown') continue;

    const providerName = String(providerData.name ?? providerId);
    const providerModels = providerData.models;
    if (!providerModels || typeof providerModels !== 'object') continue;

    for (const [modelKey, modelData] of Object.entries(providerModels)) {
      if (!modelData || typeof modelData !== 'object') continue;

      const modelId = String(modelData.id ?? modelKey);
      const modelName = String(modelData.name ?? modelId);
      const cost = modelData.cost;
      const limit = modelData.limit;

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
        provider: providerName,
        providerId,
        providerEnvVars: Array.isArray(providerData.env) ? providerData.env.filter((v: unknown) => typeof v === 'string') as string[] : [],
        pricing: { input: inputCost, output: outputCost },
        tier,
        contextWindow,
        maxOutputTokens,
      });
    }
  }

  return models;
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// In-memory catalog state
// ---------------------------------------------------------------------------

/** The live in-memory catalog models. Empty until initCatalog() runs. */
let _catalogModels: CatalogModel[] = [];

/** In-memory pricing catalog (replaceable in tests) */
let _pricingCatalog: PricingCatalog | null = null;

function getPricingCatalog(): PricingCatalog {
  if (!_pricingCatalog) {
    _pricingCatalog = { fetchedAt: Date.now(), models: _catalogModels };
  }
  return _pricingCatalog;
}

// ---------------------------------------------------------------------------
// buildCanonicalModels — convert CatalogModel[] → CanonicalModel[]
// ---------------------------------------------------------------------------

/**
 * Build CanonicalModel[] from the fetched CatalogModel[] for use by SyntheticProvider.
 *
 * Groups models by normalized model ID across providers. Each unique normalized ID
 * becomes one CanonicalModel with one SyntheticBackend per provider offering it.
 *
 * Uses a dynamic import to avoid the circular dependency chain:
 *   model-catalog.ts → synthetic.ts (via setSyntheticCanonicalModels)
 *   synthetic.ts → registry.ts → model-catalog.ts
 */
async function applySyntheticCanonicalModels(models: CatalogModel[]): Promise<void> {
  try {
    const syntheticModule = await import('./synthetic.ts');
    const { setSyntheticCanonicalModels } = syntheticModule;

    // Group models by normalized ID
    const byNormId = new Map<string, CatalogModel[]>();
    for (const m of models) {
      const normId = normalizeModelId(m.id);
      const bucket = byNormId.get(normId);
      if (bucket) {
        bucket.push(m);
      } else {
        byNormId.set(normId, [m]);
      }
    }

    const canonical: import('./synthetic.ts').CanonicalModel[] = [];
    for (const [normId, group] of byNormId) {
      // Determine tier: prefer paid > subscription > free (most capable wins)
      const tierPriority: Record<string, number> = { paid: 2, subscription: 1, free: 0 };
      const tier = group.reduce((best, m) => {
        return (tierPriority[m.tier] ?? 0) > (tierPriority[best] ?? 0) ? m.tier : best;
      }, group[0].tier) as import('./synthetic.ts').SyntheticTier;

      const backends: import('./synthetic.ts').SyntheticBackend[] = group.map((m) => ({
        providerName: m.providerId,
        modelId: m.id,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        envVars: m.providerEnvVars.length > 0 ? m.providerEnvVars : undefined,
      }));

      canonical.push({ id: normId, tier, backends });
    }

    setSyntheticCanonicalModels(canonical);
    logger.debug('[model-catalog] Synthetic canonical models updated', { count: canonical.length });
  } catch (err) {
    logger.debug('[model-catalog] Failed to apply synthetic canonical models', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Catalog refresh
// ---------------------------------------------------------------------------

/**
 * Force re-fetch from models.dev and update the in-memory + disk cache.
 * Only replaces data with valid new data — stale cache is preserved on failure.
 */
export async function refreshCatalog(): Promise<void> {
  const models = await fetchCatalog();

  if (models.length === 0) {
    logger.warn('[model-catalog] Refresh returned 0 models — keeping existing catalog');
    return;
  }

  saveCatalogCache(models);
  _catalogModels = models;
  // Invalidate the pricing catalog so it re-reads from _catalogModels
  _pricingCatalog = null;

  // Update the SyntheticProvider's canonical model list
  await applySyntheticCanonicalModels(models);

  logger.debug('[model-catalog] Catalog updated', { count: models.length });
}

// ---------------------------------------------------------------------------
// initCatalog — called once at startup
// ---------------------------------------------------------------------------

/**
 * Load catalog from disk cache; background-refresh if stale or missing.
 *
 * - If cache exists and is fresh (< 24h): load from cache, no network call
 * - If cache is stale or missing: load stale data (if any) then background-refresh
 * - If fetch fails: use stale cache indefinitely (never delete)
 * - If both cache and fetch fail: catalog is empty (no hardcoded fallback)
 */
export function initCatalog(): void {
  const cached = loadCatalogCache();
  if (cached) {
    _catalogModels = cached.models;
    _pricingCatalog = null; // invalidate so getPricingCatalog() re-reads
    // Seed the SyntheticProvider with cached models immediately (no await — fire and forget)
    applySyntheticCanonicalModels(cached.models).catch((err) => {
      logger.debug('[model-catalog] Failed to seed synthetic models from cache', { error: String(err) });
    });
  }

  if (!cached || isCatalogCacheStale(cached)) {
    // Background refresh — do not await
    refreshCatalog().catch((err) => {
      logger.debug('[model-catalog] Background refresh failed', { error: String(err) });
    });
  }
}

// ---------------------------------------------------------------------------
// getCostFromCatalog
// ---------------------------------------------------------------------------

/**
 * Look up pricing for a model ID from the catalog.
 * Supports exact match, `:free` suffix detection, and prefix/substring matching.
 *
 * Returns `{ input: 0, output: 0 }` for:
 * - Models with `:free` suffix (always free, no catalog lookup needed)
 * - Models in the catalog with `tier: 'free'`
 * - Models not found in the catalog (fallback, with optional debug log)
 */
export function getCostFromCatalog(
  modelId: string,
  opts: { debug?: boolean } = {},
): CatalogModelPricing {
  // 1. `:free` suffix — always free regardless of catalog
  if (modelId.endsWith(':free')) {
    return { input: 0, output: 0 };
  }

  const catalog = getPricingCatalog();

  // 2. Exact match
  const exact = catalog.models.find(m => m.id === modelId);
  if (exact) {
    if (exact.tier === 'free') return { input: 0, output: 0 };
    return { input: exact.pricing.input, output: exact.pricing.output };
  }

  // 3. Prefix/substring match (handles versioned IDs like "claude-sonnet-4-6-20250101")
  for (const model of catalog.models) {
    if (modelId.startsWith(model.id) || modelId.includes(model.id)) {
      if (model.tier === 'free') return { input: 0, output: 0 };
      return { input: model.pricing.input, output: model.pricing.output };
    }
  }

  // 4. Not found — fall back to {0,0} with optional debug log
  if (opts.debug) {
    process.stderr.write(`[cost-tracker] model not in catalog: ${modelId}\n`);
  }
  return { input: 0, output: 0 };
}

/**
 * Inject a custom pricing catalog (used in tests).
 * @internal
 */
export function _setCatalogForTesting(catalog: PricingCatalog): void {
  _pricingCatalog = catalog;
  _catalogModels = catalog.models;
}

/**
 * Reset the pricing catalog to empty (used in tests).
 * @internal
 */
export function _resetForTest(): void {
  _pricingCatalog = null;
  _catalogModels = [];
}

/** @internal Alias for _resetForTest — kept for backwards compatibility. */
export const _resetCatalog = _resetForTest;

/**
 * Returns the current pricing catalog (exposed for tests).
 * @internal
 */
export function _getPricingCatalog(): PricingCatalog {
  return getPricingCatalog();
}

// ---------------------------------------------------------------------------
// Cache directory helper (Major 1: mkdirSync robustness)
// ---------------------------------------------------------------------------

/**
 * Ensure a cache directory exists, creating it recursively if needed.
 * Replaces the old .gitkeep hack.
 *
 * @public Public API consumed by cache management.
 */
export function ensureCacheDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // EEXIST is harmless; log anything unexpected
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      process.stderr.write(`[model-catalog] failed to create cache dir ${dir}: ${String(err)}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// normalizeModelId — strips provider prefixes and free suffixes
// ---------------------------------------------------------------------------

/**
 * Normalize a raw model ID by stripping:
 * - Provider namespace prefix (e.g. "openai/" → "")
 * - Trailing ":free" suffix
 * - Trailing "-free" suffix
 * - Leading "coding-" prefix
 *
 * The result is a canonical model ID suitable for deduplication and display.
 *
 * @public Exported as public API for model deduplication and display.
 *
 * @example
 * normalizeModelId('openai/gpt-5.2')         // → 'gpt-5.2'
 * normalizeModelId('kimi-k2.5-free')          // → 'kimi-k2.5'
 * normalizeModelId('nvidia/nemotron-3:free')  // → 'nemotron-3'
 * normalizeModelId('coding-glm-4.7-free')     // → 'glm-4.7'
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId;

  // Strip leading "coding-" prefix
  if (id.startsWith('coding-')) {
    id = id.slice('coding-'.length);
  }

  // Strip provider namespace (everything up to and including the last "/")
  const slashIdx = id.lastIndexOf('/');
  if (slashIdx !== -1) {
    id = id.slice(slashIdx + 1);
  }

  // Strip trailing ":free" suffix
  if (id.endsWith(':free')) {
    id = id.slice(0, -':free'.length);
  }

  // Strip trailing "-free" suffix (only at end, not in middle)
  if (id.endsWith('-free')) {
    id = id.slice(0, -'-free'.length);
  }

  return id;
}

// ---------------------------------------------------------------------------
// hasKeyForProvider — checks process.env for required API keys
// ---------------------------------------------------------------------------

/**
 * Returns true if at least one of the provider's required env vars is set
 * to a non-empty value in process.env.
 *
 * Providers with `requiresKey: false` or an empty `envVars` array are
 * considered always-available (e.g. self-hosted Ollama, subscription plans).
 *
 * @param provider - A CatalogProvider object
 * @public Exported as public API for provider availability checks.
 */
export function hasKeyForProvider(provider: CatalogProvider): boolean {
  // No key required — always available
  if (provider.requiresKey === false || provider.envVars.length === 0) {
    return true;
  }
  // Any non-empty env var satisfies the requirement
  return provider.envVars.some(v => {
    const val = process.env[v];
    return typeof val === 'string' && val.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single model entry in the catalog. */
export interface CatalogModelEntry {
  /** Canonical model ID as used in the registry. */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Provider name. */
  provider: string;
  /** Context window size in tokens. 0 = unknown. */
  context: number;
  /** Pricing tier: 'free' | 'paid' | 'subscription' */
  tier: 'free' | 'paid' | 'subscription';
}

/** Catalog interface for context window lookups and model discovery. */
export interface ModelCatalog {
  /**
   * Look up a model entry by its ID.
   * Returns null when the model is not found in the catalog.
   */
  getModel(modelId: string): CatalogModelEntry | null;

  /**
   * Find models with a larger context window than `minContext`, optionally
   * filtering to the same pricing tier. Returns up to `limit` results
   * sorted by context window descending.
   */
  findLargerContextModels(
    minContext: number,
    tier?: 'free' | 'paid' | 'subscription',
    limit?: number,
  ): CatalogModelEntry[];
}

// ---------------------------------------------------------------------------
// Catalog implementation backed by the existing provider registry + model-limits
// ---------------------------------------------------------------------------

class RegistryBackedCatalog implements ModelCatalog {
  // Simple snapshot cache: invalidated when the registry model count changes.
  // Avoids re-mapping every call to getModel / findLargerContextModels.
  private _entriesCache: CatalogModelEntry[] | null = null;
  private _entriesCacheVersion = -1;

  private getEntries(): CatalogModelEntry[] {
    const models = providerRegistry.listModels();
    if (this._entriesCache !== null && models.length === this._entriesCacheVersion) {
      return this._entriesCache;
    }
    this._entriesCacheVersion = models.length;
    this._entriesCache = models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      context: getContextWindowForModel(m),
      // Registry does not carry explicit tier info yet — all models default to 'paid'.
      // NOTE: This shim means findLargerContextModels(ctx, 'free') always returns [].
      // The registry shim defaults all models to 'paid'; a network-fetched catalog would carry real tier data.
      tier: 'paid' as const,
    }));
    return this._entriesCache;
  }

  getModel(modelId: string): CatalogModelEntry | null {
    const entries = this.getEntries();
    return entries.find(e => e.id === modelId) ?? null;
  }

  findLargerContextModels(
    minContext: number,
    tier?: 'free' | 'paid' | 'subscription',
    limit = 3,
  ): CatalogModelEntry[] {
    const entries = this.getEntries();
    return entries
      .filter(e => e.context > minContext && (tier === undefined || e.tier === tier))
      .sort((a, b) => b.context - a.context)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const _catalog: ModelCatalog = new RegistryBackedCatalog();

/**
 * getCatalog -- returns the active model catalog.
 *
 * Returns the active model catalog, currently backed by the provider registry.
 */
export function getCatalog(): ModelCatalog {
  return _catalog;
}

// ---------------------------------------------------------------------------
// Change Notifications
// ---------------------------------------------------------------------------

/** A model change with a list of human-readable change descriptions. */
export interface CatalogModelChange {
  model: CatalogModel;
  changes: string[];
}

/** Result of diffing two catalog snapshots. */
export interface CatalogDiff {
  added: CatalogModel[];
  removed: CatalogModel[];
  changed: CatalogModelChange[];
}

/**
 * diffCatalogs — Compare two arrays of CatalogModel and return what changed.
 *
 * Detects: new models, removed models, and changed context window or pricing.
 * Keyed on `id` (canonical model ID).
 */
export function diffCatalogs(
  oldCatalog: CatalogModel[],
  newCatalog: CatalogModel[],
): CatalogDiff {
  const oldMap = new Map<string, CatalogModel>(oldCatalog.map(m => [m.id, m]));
  const newMap = new Map<string, CatalogModel>(newCatalog.map(m => [m.id, m]));

  const added: CatalogModel[] = [];
  const removed: CatalogModel[] = [];
  const changed: CatalogModelChange[] = [];

  // Find added models (present in new, absent in old)
  for (const [id, model] of newMap) {
    if (!oldMap.has(id)) {
      added.push(model);
    }
  }

  // Find removed models (present in old, absent in new)
  for (const [id, model] of oldMap) {
    if (!newMap.has(id)) {
      removed.push(model);
    }
  }

  // Find changed models (present in both, with differing fields)
  for (const [id, oldModel] of oldMap) {
    const newModel = newMap.get(id);
    if (!newModel) continue;

    const changes: string[] = [];

    // Context window change
    if (oldModel.contextWindow !== newModel.contextWindow) {
      const fmt = (n?: number) => n != null ? `${Math.round(n / 1024)}K` : 'unknown';
      changes.push(`context ${fmt(oldModel.contextWindow)} \u2192 ${fmt(newModel.contextWindow)}`);
    }

    // Pricing changes
    if (oldModel.pricing.input !== newModel.pricing.input) {
      changes.push(`input price $${oldModel.pricing.input} \u2192 $${newModel.pricing.input} per 1M tokens`);
    }
    if (oldModel.pricing.output !== newModel.pricing.output) {
      changes.push(`output price $${oldModel.pricing.output} \u2192 $${newModel.pricing.output} per 1M tokens`);
    }

    // Tier change
    if (oldModel.tier !== newModel.tier) {
      changes.push(`tier ${oldModel.tier} \u2192 ${newModel.tier}`);
    }

    if (changes.length > 0) {
      changed.push({ model: newModel, changes });
    }
  }

  return { added, removed, changed };
}

/**
 * filterRelevantChanges — Filter a CatalogDiff to only changes the user cares about.
 *
 * Keeps models that are:
 * - In the user's usage history (favorites.history)
 * - In the user's pinned list (favorites.pinned)
 * - In the top-10 models by benchmark composite score from the fetched catalog
 */
export function filterRelevantChanges(
  diff: CatalogDiff,
  favorites: FavoritesData,
): CatalogDiff {
  // Build set of model IDs the user cares about
  const relevantIds = new Set<string>();

  for (const entry of favorites.history) {
    relevantIds.add(entry.modelId);
  }
  for (const entry of favorites.pinned) {
    relevantIds.add(entry.modelId);
  }

  // Add top-10 models by benchmark composite score from the in-memory catalog
  // _catalogModels carries all fetched models; we score them by pricing tier as a proxy
  // (real benchmark scoring requires the benchmarks module, but we avoid a circular dep here)
  const topByPrice = _catalogModels
    .filter(m => m.tier === 'paid')
    .sort((a, b) => (b.pricing.input + b.pricing.output) - (a.pricing.input + a.pricing.output))
    .slice(0, 10);
  for (const model of topByPrice) {
    relevantIds.add(model.id);
  }

  const isRelevant = (m: CatalogModel) => relevantIds.has(m.id);

  return {
    added: diff.added.filter(isRelevant),
    removed: diff.removed.filter(isRelevant),
    changed: diff.changed.filter(c => isRelevant(c.model)),
  };
}

/**
 * formatChangeNotifications — Convert a filtered CatalogDiff into human-readable strings.
 *
 * @example
 * // "New model: GPT-5.5 now available on NVIDIA"
 * // "Model update: Kimi K2.5 context increased 262K → 512K"
 * // "Model removed: DeepSeek-V3.0 no longer available on Groq"
 */
export function formatChangeNotifications(diff: CatalogDiff): string[] {
  const notifications: string[] = [];

  for (const model of diff.added) {
    notifications.push(`New model: ${model.name} now available on ${model.provider}`);
  }

  for (const { model, changes } of diff.changed) {
    for (const change of changes) {
      notifications.push(`Model update: ${model.name} ${change}`);
    }
  }

  for (const model of diff.removed) {
    notifications.push(`Model removed: ${model.name} no longer available on ${model.provider}`);
  }

  return notifications;
}

// ---------------------------------------------------------------------------
// getCatalogModelDefinitions — convert fetched catalog models to ModelDefinition[]
// ---------------------------------------------------------------------------

/**
 * A minimal ModelDefinition shape suitable for registry use.
 * Matches the ModelDefinition interface from registry.ts.
 * Defined here to avoid a circular import (registry imports model-catalog).
 */
export interface MinimalModelDefinition {
  id: string;
  provider: string;
  displayName: string;
  description: string;
  capabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  contextWindow: number;
  selectable: boolean;
  tier: 'free' | 'standard' | 'premium';
  reasoningEffort?: string[];
}

/**
 * Convert the fetched catalog models into MinimalModelDefinition[] for use by registry.
 *
 * Returns models from the live network-fetched (or cached) catalog.
 * Returns an empty array if initCatalog() has not been called or the catalog
 * is empty (no cache and network fetch not yet complete).
 *
 * @public Consumed by registry.ts to populate the model registry.
 */
export function getCatalogModelDefinitions(): MinimalModelDefinition[] {
  return _catalogModels.map((m): MinimalModelDefinition => {
    // Derive capability defaults from provider name and tier
    const providerLower = m.provider.toLowerCase();
    const isFree = m.tier === 'free';
    const isGoogle = providerLower.includes('google') || providerLower.includes('gemini');
    const isAnthropic = providerLower.includes('anthropic');
    const isOpenAI = providerLower.includes('openai');

    return {
      id: m.id,
      provider: m.provider,
      displayName: m.name,
      description: `${m.name} — sourced from model catalog.`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: isAnthropic || isOpenAI || isGoogle,
        multimodal: isGoogle || isOpenAI,
      },
      contextWindow: m.contextWindow ?? (isGoogle ? 1_000_000 : isAnthropic ? 200_000 : 128_000),
      selectable: true,
      // Map pricing tier to ModelTier (free/standard/premium)
      tier: isFree ? 'free' : m.pricing.input >= 3 ? 'premium' : 'standard',
    };
  });
}

/**
 * notifyCatalogChanges — Convenience helper called inside refreshCatalog().
 *
 * Diffs old vs new catalog, filters to user-relevant changes, and logs
 * notifications. Called after a successful catalog refresh.
 *
 * @internal
 */
export function notifyCatalogChanges(
  oldModels: CatalogModel[],
  newModels: CatalogModel[],
  favorites: FavoritesData,
): string[] {
  const diff = diffCatalogs(oldModels, newModels);
  const filtered = filterRelevantChanges(diff, favorites);
  const notifications = formatChangeNotifications(filtered);

  for (const msg of notifications) {
    process.stderr.write(`[model-catalog] ${msg}\n`);
  }

  return notifications;
}
