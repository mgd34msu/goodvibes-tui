/**
 * model-catalog.ts
 *
 * Minimal catalog interface for Stage 8 context validation.
 *
 * This module provides a `getCatalog()` function that returns a lightweight
 * catalog object used by orchestrator.ts to look up context window limits and
 * find alternative models with larger context windows.
 *
 * Stage 1 of the dynamic model catalog plan will replace the internals of
 * this module with a full catalog fetched from models.dev. The public API
 * (`getCatalog`, `ModelCatalog`, `CatalogModelEntry`) is designed to remain
 * stable so Stage 8 code does not need to change.
 */

import fs from 'node:fs';
import { getContextWindowForModel } from './model-limits.ts';
import { providerRegistry } from './registry.ts';
import type { FavoritesData } from './favorites.ts';
import { getBenchmarks, compositeScore } from './model-benchmarks.ts';

// ---------------------------------------------------------------------------
// Provider types (Stage 1: dynamic catalog)
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
// Pricing types (Stage 7: cost tracker integration)
// ---------------------------------------------------------------------------

/** USD per 1M tokens pricing for a model. */
export interface CatalogModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

/** A model entry with full pricing + context data (Stage 7+). */
export interface CatalogModel {
  /** Canonical model ID (normalized, no provider prefix) */
  id: string;
  /** Display name */
  name: string;
  /** Provider name */
  provider: string;
  /** Pricing in USD per 1M tokens */
  pricing: CatalogModelPricing;
  /** Tier category */
  tier: 'free' | 'paid' | 'subscription';
  /** Maximum context window in tokens */
  contextWindow?: number;
}

/** Internal pricing catalog structure for testing injection. */
export interface PricingCatalog {
  fetchedAt: number;
  models: CatalogModel[];
}

// ---------------------------------------------------------------------------
// Seed pricing data — covers known models at build time.
// Stage 1 completion will replace this with models.dev network fetch.
// ---------------------------------------------------------------------------

const SEED_PRICING_MODELS: CatalogModel[] = [
  // Free tier
  { id: 'openrouter/free', name: 'OpenRouter Free', provider: 'openrouter', pricing: { input: 0, output: 0 }, tier: 'free' },

  // InceptionLabs
  { id: 'mercury-2',    name: 'Mercury 2',    provider: 'inceptionlabs', pricing: { input: 0.50, output: 1.50 }, tier: 'paid' },
  { id: 'mercury-edit', name: 'Mercury Edit', provider: 'inceptionlabs', pricing: { input: 0.50, output: 1.50 }, tier: 'paid' },

  // OpenAI
  { id: 'gpt-5.4',             name: 'GPT-5.4',      provider: 'openai', pricing: { input: 5,    output: 15   }, tier: 'paid' },
  { id: 'gpt-5.3-chat-latest', name: 'GPT-5.3 Chat', provider: 'openai', pricing: { input: 3,    output: 10   }, tier: 'paid' },
  { id: 'gpt-5-mini',          name: 'GPT-5 Mini',   provider: 'openai', pricing: { input: 0.15, output: 0.60 }, tier: 'paid' },
  { id: 'gpt-5-nano',          name: 'GPT-5 Nano',   provider: 'openai', pricing: { input: 0.05, output: 0.20 }, tier: 'paid' },
  { id: 'gpt-oss-120b',        name: 'GPT OSS 120B', provider: 'openai', pricing: { input: 0,    output: 0    }, tier: 'free' },

  // Anthropic
  { id: 'claude-opus-4-6',   name: 'Claude Opus 4.6',   provider: 'anthropic', pricing: { input: 15,   output: 75 }, tier: 'paid' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', pricing: { input: 3,    output: 15 }, tier: 'paid' },
  { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  provider: 'anthropic', pricing: { input: 0.80, output: 4  }, tier: 'paid' },

  // Google
  { id: 'gemini-3.1-pro',        name: 'Gemini 3.1 Pro',        provider: 'google', pricing: { input: 1.25,  output: 5    }, tier: 'paid' },
  { id: 'gemini-3-flash',        name: 'Gemini 3 Flash',        provider: 'google', pricing: { input: 0.075, output: 0.30 }, tier: 'paid' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', provider: 'google', pricing: { input: 0.02,  output: 0.10 }, tier: 'paid' },
  { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',        provider: 'google', pricing: { input: 1.25,  output: 5    }, tier: 'paid' },
];

// In-memory pricing catalog (replaceable in tests and Stage 1 network fetch)
let _pricingCatalog: PricingCatalog | null = null;

function getPricingCatalog(): PricingCatalog {
  if (!_pricingCatalog) {
    _pricingCatalog = { fetchedAt: Date.now(), models: SEED_PRICING_MODELS };
  }
  return _pricingCatalog;
}

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
 * Inject a custom pricing catalog (used in tests and Stage 1 network fetch).
 * @internal
 */
export function _setCatalogForTesting(catalog: PricingCatalog): void {
  _pricingCatalog = catalog;
}

/**
 * Reset the pricing catalog to seed data (used in tests).
 * @internal
 */
export function _resetForTest(): void {
  _pricingCatalog = null;
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
 * @public Public API consumed by Stage 2/3 cache management.
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
 * @public Exported as public API for Stage 2/3 model deduplication and display.
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
 * @public Exported as public API for Stage 2/3 provider availability checks.
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

/** Minimal catalog interface for Stage 8 context validation. */
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
      // Stage 1 (dynamic catalog from models.dev) will replace this with real tier data.
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
 * In Stage 8 this returns a registry-backed shim. After Stage 1, this will
 * return the full dynamic catalog sourced from models.dev.
 */
export function getCatalog(): ModelCatalog {
  return _catalog;
}

// ---------------------------------------------------------------------------
// Stage 9: Change Notifications
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
 * - In the top-10 models by benchmark composite score
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
  const benchmarkEntries = getBenchmarks();
  const scored = benchmarkEntries
    .map(entry => ({ entry, score: compositeScore(entry.benchmarks) }))
    .filter((x): x is { entry: typeof x.entry; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  for (const { entry } of scored) {
    relevantIds.add(entry.modelId);
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
 * // "Model update: Kimi K2.5 context increased 262K \u2192 512K"
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
// getCatalogModelDefinitions — convert seed pricing models to ModelDefinition[]
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
 * Convert SEED_PRICING_MODELS into MinimalModelDefinition[] for use by registry.
 *
 * Provides sensible defaults for capabilities and context windows based on
 * pricing tier and provider. Stage 1 will replace seed data with full
 * catalog from models.dev including real capabilities and context windows.
 *
 * @public Consumed by registry.ts Stage 4 to replace BUILTIN_MODEL_REGISTRY.
 */
export function getCatalogModelDefinitions(): MinimalModelDefinition[] {
  return SEED_PRICING_MODELS.map((m): MinimalModelDefinition => {
    // Derive capability defaults from provider and tier
    const isFree = m.tier === 'free';
    const isGoogle = m.provider === 'google';
    const isAnthropic = m.provider === 'anthropic';
    const isOpenAI = m.provider === 'openai';

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
      // Context window defaults — Stage 1 will replace with real values from models.dev
      contextWindow: isGoogle ? 1_000_000 : isAnthropic ? 200_000 : 128_000,
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
 * notifications. Stage 1 will call this after a successful network fetch.
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
