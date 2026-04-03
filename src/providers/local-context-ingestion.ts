/**
 * local-context-ingestion.ts
 *
 * G00: Local provider `max_context_length` ingestion.
 *
 * Fetches the /v1/models endpoint for local/custom providers and extracts
 * per-model `max_context_length` values. Results are keyed by model ID and
 * stored in an in-memory cache per provider.
 *
 * Feature flag: `local-provider-context-ingestion`
 * When disabled, this module is a no-op and callers fall back to the
 * statically-configured context window.
 *
 * Provenance ladder (highest to lowest):
 *   provider_api     — value from /v1/models max_context_length
 *   configured_cap   — explicit contextWindow in custom provider config
 *   fallback         — DEFAULT_CONTEXT_WINDOW constant
 */

import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Provenance tag for a resolved context window value.
 *
 * - `provider_api`   — sourced from the provider's /v1/models endpoint
 * - `configured_cap` — explicit value from the custom provider config file
 * - `fallback`       — DEFAULT_CONTEXT_WINDOW (no config, no API response)
 */
export type ContextWindowProvenance = 'provider_api' | 'configured_cap' | 'fallback';

/**
 * A fully-resolved context window with its provenance and metadata.
 */
export interface ResolvedContextWindow {
  /** Effective context window in tokens, ready for use in budgeting. */
  tokens: number;
  /** How this value was resolved. */
  provenance: ContextWindowProvenance;
  /**
   * When provenance is `provider_api`, the raw value from the API.
   * May differ from `tokens` when a configured_cap is applied.
   */
  apiReportedTokens?: number;
  /**
   * When provenance is `provider_api`, the safe cap that was applied
   * (equal to `tokens` when no cap was enforced).
   */
  safeCap?: number;
}

/**
 * Shape of a single model entry in an OpenAI-compatible /v1/models response.
 */
interface OpenAICompatModelEntry {
  id: string;
  /** Context window in tokens — present in Ollama, llama.cpp, LM Studio etc. */
  max_context_length?: number;
  /** Alternate field name used by some implementations. */
  context_length?: number;
  /** Some providers nest limits inside an object. */
  limits?: {
    max_context_length?: number;
    context_length?: number;
  };
}

interface OpenAICompatModelsResponse {
  data: OpenAICompatModelEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default fallback context window when neither the API nor the config
 * provides a value.
 */
export const DEFAULT_CONTEXT_WINDOW = 8_192;

/** How long to wait for a /v1/models response before giving up. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Grace period between ingestion attempts for the same provider.
 * Prevents hammering a slow or offline local server.
 */
const CACHE_TTL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Epoch ms when this entry was fetched. */
  fetchedAt: number;
  /** Map of model ID → raw context_length from the API (tokens). */
  models: Map<string, number>;
  /** True if the last fetch attempt failed (prevents repeated retries). */
  failed: boolean;
}

const providerCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single model entry and extract its context window value.
 * Tries multiple field names for broad compatibility.
 */
function extractContextLength(entry: OpenAICompatModelEntry): number | null {
  // Direct fields (most common)
  if (typeof entry.max_context_length === 'number' && entry.max_context_length > 0) {
    return entry.max_context_length;
  }
  if (typeof entry.context_length === 'number' && entry.context_length > 0) {
    return entry.context_length;
  }
  // Nested limits object
  if (entry.limits) {
    if (typeof entry.limits.max_context_length === 'number' && entry.limits.max_context_length > 0) {
      return entry.limits.max_context_length;
    }
    if (typeof entry.limits.context_length === 'number' && entry.limits.context_length > 0) {
      return entry.limits.context_length;
    }
  }
  return null;
}

/**
 * Fetch /v1/models from the given base URL and return a map of
 * model ID → context_length. Returns null on fetch error or invalid response.
 *
 * @param baseURL - Provider base URL. **Must include the `/v1` path component**
 *   (e.g. `http://localhost:11434/v1`). The function appends `/models` to this
 *   value, so omitting `/v1` will produce an incorrect endpoint URL such as
 *   `http://localhost:11434/models` instead of `http://localhost:11434/v1/models`.
 * @param apiKey - Optional API key sent as a Bearer token in the Authorization header.
 */
async function fetchProviderModels(
  baseURL: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const url = baseURL.replace(/\/$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      logger.debug('[local-context-ingestion] Non-OK response from provider', {
        url,
        status: response.status,
      });
      return null;
    }

    const json = await response.json() as OpenAICompatModelsResponse;
    if (!Array.isArray(json?.data)) {
      logger.debug('[local-context-ingestion] Unexpected response shape', { url });
      return null;
    }

    const result = new Map<string, number>();
    for (const entry of json.data) {
      if (typeof entry.id !== 'string') continue;
      const ctxLen = extractContextLength(entry);
      if (ctxLen !== null) {
        result.set(entry.id, ctxLen);
      }
    }

    logger.debug('[local-context-ingestion] Fetched model context windows', {
      url,
      count: result.size,
    });
    return result;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      logger.debug('[local-context-ingestion] Fetch timed out', { url });
    } else {
      logger.debug('[local-context-ingestion] Fetch failed', {
        url,
        error: String(err),
      });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest context window data from a local provider's /v1/models endpoint.
 *
 * Results are cached in-memory for `CACHE_TTL_MS`. Repeated calls within the
 * TTL return the cached value immediately without making a network request.
 *
 * @param providerName - Unique provider name (used as cache key).
 * @param baseURL      - Provider base URL (e.g. `http://localhost:11434/v1`).
 * @param apiKey       - Optional API key sent as Bearer token.
 * @returns Map of model ID → raw context length from the API, or null if
 *          the provider is offline or returned an unrecognised response.
 */
export async function ingestLocalProviderContextWindows(
  providerName: string,
  baseURL: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const now = Date.now();
  const cached = providerCache.get(providerName);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.failed ? null : cached.models;
  }

  const models = await fetchProviderModels(baseURL, apiKey);
  providerCache.set(providerName, {
    fetchedAt: now,
    models: models ?? new Map(),
    failed: models === null,
  });

  return models;
}

/**
 * Resolve the effective context window for a single model with provenance.
 *
 * Priority ladder:
 *   1. provider_api  — `apiContextLength` when valid (> 0)
 *   2. configured_cap — `configuredContextWindow` when valid (> 0)
 *   3. fallback      — `DEFAULT_CONTEXT_WINDOW`
 *
 * @param modelId                - Model ID (for logging).
 * @param apiContextLength       - Context length from /v1/models (null if not available).
 * @param configuredContextWindow - Context window from custom provider config (0 if not set).
 * @returns Resolved context window with provenance metadata.
 */
export function resolveContextWindow(
  modelId: string,
  apiContextLength: number | null,
  configuredContextWindow: number,
): ResolvedContextWindow {
  if (apiContextLength !== null && apiContextLength > 0) {
    return {
      tokens: apiContextLength,
      provenance: 'provider_api',
      apiReportedTokens: apiContextLength,
      safeCap: apiContextLength,
    };
  }

  if (configuredContextWindow > 0) {
    return {
      tokens: configuredContextWindow,
      provenance: 'configured_cap',
    };
  }

  logger.debug('[local-context-ingestion] No context window available, using fallback', {
    modelId,
    fallback: DEFAULT_CONTEXT_WINDOW,
  });
  return {
    tokens: DEFAULT_CONTEXT_WINDOW,
    provenance: 'fallback',
  };
}

/**
 * Clear the ingestion cache for a specific provider.
 * Useful after a provider config is reloaded.
 */
export function clearProviderContextCache(providerName: string): void {
  providerCache.delete(providerName);
}

/**
 * Clear the entire ingestion cache.
 * Called when the `local-provider-context-ingestion` feature flag is toggled.
 */
export function clearAllContextCaches(): void {
  providerCache.clear();
}

/**
 * Return the current cache snapshot for diagnostics.
 * Keys are provider names; values include fetchedAt and model count.
 */
export function getContextIngestionDiagnostics(): Array<{
  providerName: string;
  fetchedAt: number;
  modelCount: number;
  failed: boolean;
}> {
  return Array.from(providerCache.entries()).map(([providerName, entry]) => ({
    providerName,
    fetchedAt: entry.fetchedAt,
    modelCount: entry.models.size,
    failed: entry.failed,
  }));
}
