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
import { getContextWindowForModel, getPricingForModel } from './model-limits.ts';
import { providerRegistry } from './registry.ts';
import type { FavoritesData } from './favorites.ts';
import { loadFavorites } from './favorites.ts';
import { getTopBenchmarkModelIds } from './model-benchmarks.ts';

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
  /**
   * Display name from models.dev. Varies by provider — do NOT use as a reliable
   * cross-provider identifier. Within a broad family, slug-normalised names are
   * used as a best-effort sub-grouping heuristic (see applySyntheticCanonicalModels).
   */
  name: string;
  /**
   * Model family from models.dev (e.g. 'kimi', 'glm-flash', 'deepseek-thinking').
   * Consistent across providers for the same underlying model family.
   * Use this field for cross-provider grouping in the synthetic layer.
   */
  family?: string;
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
  /** Whether this model supports extended reasoning/thinking. */
  reasoning?: boolean;
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
  'kimi-for-coding',
  'llama',
  'lmstudio',
]);

/** Provider IDs that are shut down / no longer active. */
const SHUTDOWN_PROVIDERS = new Set([
  'iflow',
  'iflowcn',
]);

function categorizeProvider(providerId: string): 'subscription' | 'shutdown' | 'normal' {
  if (providerId.includes('coding-plan')) return 'subscription';
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
        providerEnvVars: Array.isArray(providerData.env) ? providerData.env.filter((v: unknown) => typeof v === 'string') as string[] : [],
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

/** The last-computed synthetic canonical models. Set by applySyntheticCanonicalModels(). */
let _syntheticCanonicals: import('./synthetic.ts').CanonicalModel[] = [];

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
 * Grouping strategy (two-level):
 *
 * models.dev `family` values span two levels of granularity:
 *   - Broad families (e.g. 'gpt', 'qwen', 'llama', 'deepseek') lump 100-450 models
 *     spanning many generations into one bucket — useless for failover grouping.
 *   - Granular families (e.g. 'claude-sonnet', 'gemini-flash', 'kimi-thinking') are
 *     already specific enough and work well as grouping keys.
 *
 * Detection heuristic: count unique model names within each family across all providers.
 * Families with more than MAX_FAMILY_UNIQUE_NAMES distinct names are considered broad;
 * within those we sub-group by slug-normalised name via `nameToSlug()` (name is used as a
 * heuristic — it tends to be consistent for the same underlying model within models.dev, but
 * can vary across providers; slug normalisation merges minor punctuation/spacing differences).
 * Granular families (few unique names) keep the family slug as their canonical ID.
 *
 * Only keeps groups where 2+ distinct providers have configured API keys, since
 * single-provider groups provide no failover value for the synthetic layer.
 *
 * Uses a dynamic import to avoid the circular dependency chain:
 *   model-catalog.ts → synthetic.ts (via setSyntheticCanonicalModels)
 *   synthetic.ts → registry.ts → model-catalog.ts
 */

/**
 * Families with more unique model names than this threshold are considered "broad"
 * and will be sub-grouped by model name instead of treated as one canonical group.
 */
const MAX_FAMILY_UNIQUE_NAMES = 20;

/**
 * Convert a model name into a slug suitable for use as a canonical model ID.
 * Lowercases and strips ALL non-alphanumeric characters entirely (not replaced
 * with hyphens), so "GPT-4o", "GPT 4o", and "GPT4o" all produce "gpt4o".
 */
function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize a model name for broad-family sub-grouping by stripping version numbers,
 * date stamps, and common variant suffixes that don't distinguish the underlying model.
 *
 * Examples:
 *   "Kimi K2 Instruct" → "kimik2"
 *   "Kimi K2 0905"     → "kimik2"
 *   "GPT-5.2"          → "gpt5"
 *   "GPT-5.4"          → "gpt5"
 *   "DeepSeek-V3-0324" → "deepseekv3"
 *
 * Steps:
 *   1. Lowercase
 *   2. Strip common variant suffixes (instruct, chat, latest, preview, free, turbo, fast, base, pt, online)
 *   3. Strip version-like numeric patterns (v1, v2, 0324, 0905, 2507, etc.)
 *   4. Strip model size indicators (8b, 70b, 120b, 235b, etc.) that duplicate family info
 *   5. Apply nameToSlug (strip all non-alphanumeric)
 */
function normalizeModelName(name: string): string {
  let n = name.toLowerCase();
  // Strip variant suffixes (word-boundary aware).
  // Suffixes like pro/plus/max are safe to remove here because normalizeModelName() is ONLY
  // called for broad families (>20 unique normalised names). In those families the top-level
  // name (e.g. "Gemini", "GPT") is the canonical identity; granular models such as
  // "Gemini Pro" live in smaller families where this function is never invoked.
  n = n.replace(/\b(instruct|chat|latest|preview|free|turbo|fast|base|pt|online|thinking|lite|mini|nano|pro|plus|ultra|max|standard|default|code|coder|coding|it|bf16|fp8|fp16|awq|gptq|gguf|bnb|qlora|lora|v1|v2|v3|v4|v5|v6|v7|v8|v9)\b/g, ' ');
  // Strip decimal minor version suffixes (e.g. GPT-5.1 → GPT-5, GPT-5.2 → GPT-5)
  // Must run before the size-indicator strip to avoid consuming '5.1b'
  n = n.replace(/\b([a-z0-9]+)\.([0-9]{1,2})\b/g, '$1');
  // Strip 4-digit date stamps that look like MMDD or YYMM (e.g. 0324, 0905, 2507, 2512)
  n = n.replace(/\b(?:(0[1-9]|[12][0-9]|3[01])(0[1-9]|1[0-2])|(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01]))\b/g, ' '); // DDMM or MMDD
  // YYYYMMDD (20240324), YYYYMM (202403), or YYMM (2403) — year range 2020–2039, valid month only
  n = n.replace(/\b(?:20[2-3][0-9](?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])|20[2-3][0-9](?:0[1-9]|1[0-2])|[2-3][0-9](?:0[1-9]|1[0-2]))\b/g, ' ');
  // Strip model size indicators (e.g. 7b, 8b, 13b, 30b, 32b, 70b, 72b, 120b, 235b, 480b, 671b, 1.5b, 3b)
  n = n.replace(/\b[0-9]+(?:\.[0-9]+)?[bB]\b/g, ' ');
  // Strip parameter count patterns like 235B-A22B (MoE notation)
  n = n.replace(/\b[0-9]+[bB]-[aA][0-9]+[bB]\b/g, ' ');
  // Apply slug normalisation (strips spaces, dots, dashes, etc.)
  return nameToSlug(n);
}

async function applySyntheticCanonicalModels(models: CatalogModel[]): Promise<void> {
  try {
    const syntheticModule = await import('./synthetic.ts');
    const { setSyntheticCanonicalModels } = syntheticModule;

    // Step 1: Group models by family
    const byFamily = new Map<string, CatalogModel[]>();
    for (const m of models) {
      if (!m.family) continue;
      const bucket = byFamily.get(m.family);
      if (bucket) {
        bucket.push(m);
      } else {
        byFamily.set(m.family, [m]);
      }
    }

    // Step 2: For each family, determine if it is broad or granular.
    // Broad families: sub-group by normalised name. Granular: use family as canonical ID.
    // Collect final groups as Map<canonicalId, CatalogModel[]>.
    const canonicalGroups = new Map<string, CatalogModel[]>();

    for (const [family, group] of byFamily) {
      const uniqueNames = new Set(group.map(m => normalizeModelName(m.name)));
      const isBroad = uniqueNames.size > MAX_FAMILY_UNIQUE_NAMES;

      if (isBroad) {
        // Sub-group by normalised name — each distinct normalised slug becomes its own canonical entry.
        // Uses normalizeModelName() which strips version stamps and variant suffixes before slugging,
        // so "Kimi K2", "Kimi K2 Instruct", "Kimi K2 0905" all collapse to "kimik2".
        const byName = new Map<string, CatalogModel[]>();
        for (const m of group) {
          const key = normalizeModelName(m.name);
          const bucket = byName.get(key);
          if (bucket) {
            bucket.push(m);
          } else {
            byName.set(key, [m]);
          }
        }
        for (const [slug, nameGroup] of byName) {
          // If the same slug was already claimed by another family, prefix with family name.
          const canonicalId = canonicalGroups.has(slug) ? `${family}-${slug}` : slug;
          const existing = canonicalGroups.get(canonicalId);
          if (existing) {
            existing.push(...nameGroup);
          } else {
            canonicalGroups.set(canonicalId, nameGroup);
          }
        }
      } else {
        // Granular family — use family slug directly as canonical ID.
        const existing = canonicalGroups.get(family);
        if (existing) {
          existing.push(...group);
        } else {
          canonicalGroups.set(family, group);
        }
      }
    }

    // Step 3: Build CanonicalModel entries, filtering to multi-provider groups.
    const canonical: import('./synthetic.ts').CanonicalModel[] = [];
    for (const [canonicalId, group] of canonicalGroups) {
      const allBackends: import('./synthetic.ts').SyntheticBackend[] = group.map((m) => ({
        providerName: m.providerId,
        modelId: m.id,
        registryKey: `${m.providerId}:${m.id}`,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        envVars: m.providerEnvVars.length > 0 ? m.providerEnvVars : undefined,
      }));

      // Only include groups where 2+ distinct providers have configured keys
      const keyedBackends = allBackends.filter((b) => {
        const vars = b.envVars;
        if (!vars || vars.length === 0) return true;
        return vars.some(v => {
          const val = process.env[v];
          return typeof val === 'string' && val.length > 0;
        });
      });
      const distinctProviders = new Set(keyedBackends.map(b => b.providerName)).size;
      if (distinctProviders < 2) continue;

      // Determine tier: prefer free > subscription > paid (most accessible wins).
      // If ANY backend is free, the canonical is free — users get free backends first.
      const tierPriority: Record<string, number> = { free: 2, subscription: 1, paid: 0 };
      const tier = group.reduce((best, m) => {
        return (tierPriority[m.tier] ?? 0) > (tierPriority[best] ?? 0) ? m.tier : best;
      }, group[0].tier) as import('./synthetic.ts').SyntheticTier;

      canonical.push({ id: canonicalId, tier, backends: allBackends, backendCount: allBackends.length, keyedBackendCount: distinctProviders });
    }

    _syntheticCanonicals = canonical;
    setSyntheticCanonicalModels(canonical);
    logger.debug('[model-catalog] Synthetic canonicals built', {
      count: canonical.length,
      sampleIds: canonical.slice(0, 20).map(c => c.id),
      sampleBackendCounts: canonical.slice(0, 20).map(c => c.backends.length),
    });
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
  const oldModels = [..._catalogModels];
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

  // Notify about model changes (new, removed, repriced models)
  const favorites = await loadFavorites();
  notifyCatalogChanges(oldModels, models, favorites);
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

  // 4. Not found in catalog — try OpenRouter pricing from model-limits as fallback
  // (covers first-startup with empty catalog and no network)
  if (catalog.models.length === 0) {
    // Extract provider from "provider/model-id" format if present
    const slashIdx = modelId.indexOf('/');
    const provider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : '';
    const orPricing = getPricingForModel(modelId, provider);
    if (orPricing) {
      // getPricingForModel returns per-token USD; convert to per-million
      return { input: orPricing.prompt * 1_000_000, output: orPricing.completion * 1_000_000 };
    }
  }

  if (opts.debug) {
    logger.debug(`[cost-tracker] model not in catalog: ${modelId}`);
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
 * Exposed for unit tests — wraps the private nameToSlug function.
 * @internal
 */
export function _nameToSlugForTest(name: string): string {
  return nameToSlug(name);
}

/**
 * Exposed for unit tests — wraps the private normalizeModelName function.
 * @internal
 */
export function _normalizeModelNameForTest(name: string): string {
  return normalizeModelName(name);
}

/**
 * Exposed for unit tests — wraps the private applySyntheticCanonicalModels function.
 * @internal
 */
export async function _applySyntheticCanonicalModelsForTest(models: CatalogModel[]): Promise<void> {
  return applySyntheticCanonicalModels(models);
}

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
      logger.warn('[model-catalog] failed to create cache dir', { dir, error: String(err) });
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
      tier: (m.tier ?? 'paid') as 'free' | 'paid' | 'subscription',
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
// Configured provider detection
// ---------------------------------------------------------------------------

/**
 * getConfiguredProviderIds — returns provider IDs that are "configured".
 *
 * A provider is considered configured when:
 *   - It has no required env vars (e.g. self-hosted Ollama, subscription plans), OR
 *   - At least one of its required env vars is set to a non-empty value in process.env.
 *
 * Uses the live _catalogModels to determine which env vars each provider requires.
 * Returns an empty array if initCatalog() has not yet populated _catalogModels.
 *
 * @public Used by the model picker to populate the configuredProviders filter.
 */
export function getConfiguredProviderIds(): string[] {
  // Build a map: providerId → envVars[]
  const providerEnvMap = new Map<string, string[]>();
  for (const m of _catalogModels) {
    if (!providerEnvMap.has(m.providerId)) {
      providerEnvMap.set(m.providerId, m.providerEnvVars);
    }
  }

  const configured: string[] = [];
  for (const [providerId, envVars] of providerEnvMap) {
    if (envVars.length === 0) {
      // No key required — always available
      configured.push(providerId);
    } else if (envVars.some(v => {
      const val = process.env[v];
      return typeof val === 'string' && val.length > 0;
    })) {
      configured.push(providerId);
    }
  }
  return configured;
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

  // Add top-10 models by benchmark composite score
  for (const id of getTopBenchmarkModelIds(10)) {
    relevantIds.add(id);
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
  /** Compound unique key: `${provider}:${id}`. */
  registryKey: string;
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
  tier: 'free' | 'standard' | 'premium' | 'subscription';
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
/**
 * Convert the synthetic canonical models into MinimalModelDefinition[] for use by registry.
 *
 * Returns models with provider='synthetic' and canonical slug IDs.
 * Returns an empty array if initCatalog() has not been called or no multi-provider
 * groups were found.
 *
 * @public Consumed by registry.ts to populate synthetic models in the model registry.
 */
/**
 * Returns the set of all raw backend model IDs from the synthetic canonical models.
 * Used by getModelRegistry() to exclude catalog models that are already represented
 * as synthetic canonical backends, preventing duplicate entries in the picker.
 */
export function getSyntheticBackendModelIds(): Set<string> {
  return new Set(_syntheticCanonicals.flatMap(c => c.backends.map(b => b.modelId)));
}

export function getSyntheticModelDefinitions(): MinimalModelDefinition[] {
  const defs = _syntheticCanonicals.map((c): MinimalModelDefinition => {
    // Use the backend with the largest context window as representative
    const bestBackend = c.backends.reduce((best, b) =>
      (b.contextWindow ?? 0) > (best.contextWindow ?? 0) ? b : best, c.backends[0]);

    // Find a catalog model whose ID matches one of the backends, to extract display name
    const catalogMatch = _catalogModels.find(m =>
      c.backends.some(b => b.modelId === m.id)
    );

    const displayName = catalogMatch?.name ?? c.id;
    const hasReasoning = catalogMatch?.reasoning === true;

    return {
      id: c.id,
      provider: 'synthetic',
      registryKey: `synthetic:${c.id}`,
      displayName,
      description: `Synthetic failover model — ${c.backendCount} provider${c.backendCount !== 1 ? 's' : ''} available`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: hasReasoning,
        multimodal: false,
      },
      contextWindow: bestBackend?.contextWindow ?? 128_000,
      selectable: true,
      tier: c.tier === 'free' ? 'free' : c.tier === 'subscription' ? 'subscription' : 'standard',
      ...(hasReasoning ? { reasoningEffort: ['instant', 'low', 'medium', 'high'] } : {}),
    };
  });
  logger.debug('[model-catalog] getSyntheticModelDefinitions', {
    count: defs.length,
    sampleIds: defs.slice(0, 20).map(d => d.id),
  });
  return defs;
}

export function getCatalogModelDefinitions(): MinimalModelDefinition[] {
  return _catalogModels.map((m): MinimalModelDefinition => {
    // Derive capability defaults from provider name and tier
    const providerLower = m.provider.toLowerCase();
    const isFree = m.tier === 'free';
    const isGoogle = providerLower.includes('google') || providerLower.includes('gemini');
    const isAnthropic = providerLower.includes('anthropic');
    const isOpenAI = providerLower.includes('openai');

    // m.reasoning comes from models.dev `reasoning` flag (fresh fetch).
    // Fall back to provider-based heuristic for cached entries that pre-date
    // the reasoning field (cache written before this code was added).
    const hasReasoning = m.reasoning === true || isAnthropic || isOpenAI || isGoogle;
    return {
      id: m.id,
      provider: m.providerId,
      registryKey: `${m.providerId}:${m.id}`,
      displayName: m.name,
      description: `${m.name} — sourced from model catalog.`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: hasReasoning,
        multimodal: isGoogle || isOpenAI,
      },
      contextWindow: m.contextWindow ?? (isGoogle ? 1_000_000 : isAnthropic ? 200_000 : 128_000),
      selectable: true,
      // Map pricing tier to ModelTier (free/standard/premium/subscription)
      tier: m.tier === 'subscription' ? 'subscription' : isFree ? 'free' : m.pricing.input >= 3 ? 'premium' : 'standard',
      // Populate effort picker levels for reasoning-capable models
      ...(hasReasoning ? { reasoningEffort: ['instant', 'low', 'medium', 'high'] } : {}),
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
    logger.info(`[model-catalog] ${msg}`);
  }

  return notifications;
}
