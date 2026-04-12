/**
 * local-context-ingestion.ts
 *
 * Local provider `max_context_length` ingestion.
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
import { discoverContextWindows } from './context-discovery.ts';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default fallback context window when neither the API nor the config
 * provides a value.
 */
export const DEFAULT_CONTEXT_WINDOW = 8_192;

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
export class LocalContextIngestionService {
  private readonly providerCache = new Map<string, CacheEntry>();

  async ingestProviderContextWindows(
    providerName: string,
    baseURL: string,
    apiKey?: string,
  ): Promise<Map<string, number> | null> {
    const now = Date.now();
    const cached = this.providerCache.get(providerName);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.failed ? null : cached.models;
    }

    // Use multi-endpoint discovery (probes LM Studio, Ollama, OpenAI-compat, llama.cpp, TGI)
    // Returns an empty Map when all probes fail — treat that as a fetch failure.
    const discovered = await discoverContextWindows(baseURL, apiKey);
    const failed = discovered.size === 0;
    this.providerCache.set(providerName, {
      fetchedAt: now,
      models: discovered,
      failed,
    });

    return failed ? null : discovered;
  }

  clearProviderCache(providerName: string): void {
    this.providerCache.delete(providerName);
  }

  clearAllCaches(): void {
    this.providerCache.clear();
  }

  getDiagnostics(): Array<{
    providerName: string;
    fetchedAt: number;
    modelCount: number;
    failed: boolean;
  }> {
    return Array.from(this.providerCache.entries()).map(([providerName, entry]) => ({
      providerName,
      fetchedAt: entry.fetchedAt,
      modelCount: entry.models.size,
      failed: entry.failed,
    }));
  }
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
