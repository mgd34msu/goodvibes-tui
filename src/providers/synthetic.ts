import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { ProviderError, isRateLimitOrQuotaError } from '../types/errors.ts';
import { logger } from '../utils/logger.ts';
import { getBenchmarks, compositeScore } from './model-benchmarks.ts';

// --- Types ---

export interface SyntheticBackend {
  /** Provider name as registered in the provider registry. */
  providerName: string;
  /** Model ID as understood by the provider. */
  modelId: string;
  /**
   * Compound registry key for this backend: `${providerName}:${modelId}`.
   * Used for unambiguous routing and provider lookup.
   */
  registryKey?: string;
  /** Context window in tokens (used for backend sort order). */
  contextWindow?: number;
  /** Maximum output tokens (used as tiebreaker in sort order). */
  maxOutputTokens?: number;
  /**
   * Environment variable names that gate this backend.
   * Empty array or undefined means no key required (always available).
   */
  envVars?: string[];
}

/**
 * Returns true if the backend has at least one configured API key.
 * Backends with empty envVars (or undefined) are always available (no key needed).
 *
 * Inlined here to avoid the circular import chain:
 * synthetic.ts -> model-catalog.ts -> registry.ts -> synthetic.ts
 */
function hasKey(backend: SyntheticBackend): boolean {
  const vars = backend.envVars;
  if (!vars || vars.length === 0) return true;
  return vars.some(v => {
    const val = process.env[v];
    return typeof val === 'string' && val.length > 0;
  });
}

export type SyntheticTier = 'free' | 'paid' | 'subscription';

/**
 * Maps normalised synthetic model IDs to their ordered backend list.
 * Type annotation used by registry.ts for backend resolution.
 */
export type SyntheticModelMap = Record<string, SyntheticBackend[]>;

/**
 * A canonical model offered by the SyntheticProvider.
 * Groups backends by tier so failover never crosses tier boundaries.
 */
export interface CanonicalModel {
  /** Canonical model ID exposed to callers (e.g. 'kimi-k2.5'). */
  id: string;
  /** Pricing tier — determines which backend pool is used for failover. */
  tier: SyntheticTier;
  /** Ordered list of backends to try within this tier. */
  backends: SyntheticBackend[];
}

// --- Live catalog ---
// Populated by the catalog fetch (model-catalog.ts) after a successful network
// request. Until then the catalog is empty and the synthetic provider returns
// no models — there is no hardcoded fallback.

let _canonicalCatalog: CanonicalModel[] | null = null;

/**
 * Inject the canonical model list fetched from the catalog.
 * Called by the catalog fetch implementation after a successful fetch.
 */
export function setSyntheticCanonicalModels(models: CanonicalModel[]): void {
  _canonicalCatalog = models;
}

/**
 * Inject a custom catalog for testing.
 * @internal
 */
export function _setSyntheticCatalogForTest(models: CanonicalModel[]): void {
  _canonicalCatalog = models;
}

/**
 * Reset the injected catalog to empty (no models available).
 * @internal
 */
export function _resetSyntheticCatalog(): void {
  _canonicalCatalog = null;
}

/**
 * Returns the active canonical model catalog.
 * Returns an empty array if the catalog has not been fetched yet.
 */
function getCatalogModels(): CanonicalModel[] {
  return _canonicalCatalog ?? [];
}

// --- Backend selection ---

/**
 * Build a filtered and sorted backend list for a given synthetic model ID.
 *
 * Filtering rules:
 * - Only backends matching the canonical model's tier (tier-isolated failover)
 * - Only backends where the user has a configured API key (key-aware)
 *
 * Sort order: contextWindow descending → maxOutputTokens descending.
 *
 * Returns null if the model is not found in the catalog.
 * Returns an empty array if the model exists but no backends have keys.
 */
function buildBackendList(
  syntheticId: string,
): { backends: SyntheticBackend[]; canonical: CanonicalModel } | null {
  const catalog = getCatalogModels();
  const canonical = catalog.find(m => m.id === syntheticId);
  if (!canonical) return null;

  // Key-aware filtering: skip backends without configured keys
  const keyed = canonical.backends.filter(hasKey);

  // Sort: context desc → maxOutput desc
  const sorted = keyed.slice().sort((a, b) => {
    const ctxDiff = (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
    if (ctxDiff !== 0) return ctxDiff;
    return (b.maxOutputTokens ?? 0) - (a.maxOutputTokens ?? 0);
  });

  return { backends: sorted, canonical };
}

/**
 * Resolve 'best-free' to the canonical ID of the highest composite-scored
 * free model for which the user has at least one backend key configured.
 *
 * Returns null if no free models have keys or benchmark data.
 */
function resolveBestFree(): string | null {
  const catalog = getCatalogModels();
  const freeModels = catalog.filter(m => m.tier === 'free');

  let bestId: string | null = null;
  let bestScore = -Infinity;

  for (const model of freeModels) {
    // Check if any backend for this model has a key
    const hasAnyKey = model.backends.some(hasKey);
    if (!hasAnyKey) continue;

    // Look up benchmark score for this model
    const entry = getBenchmarks(model.id);
    const score = entry ? compositeScore(entry.benchmarks) : null;
    // Models with no benchmark data score lowest but still qualify
    const effectiveScore = score ?? -1;

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestId = model.id;
    }
  }

  return bestId;
}

// --- Default cooldown ---
const DEFAULT_COOLDOWN_MS = 60_000;

// --- SyntheticProvider ---

export class SyntheticProvider implements LLMProvider {
  readonly name = 'synthetic';

  /** Returns a live snapshot of canonical model IDs each time it is accessed. */
  get models(): string[] {
    return [
      ...getCatalogModels().map(m => m.id),
      'best-free',
    ];
  }

  // Track cooldowns: syntheticModelId -> array of expiresAt timestamps indexed by resolved backend position
  private cooldowns = new Map<string, number[]>();
  // Track active backend index per resolved model ID
  private activeBackend = new Map<string, number>();

  constructor() {}

  async chat(params: ChatRequest): Promise<ChatResponse> {
    let syntheticId = params.model;

    // Resolve 'best-free' alias
    if (syntheticId === 'best-free') {
      const resolved = resolveBestFree();
      if (!resolved) {
        throw new ProviderError(
          'No API keys configured for any provider offering free models',
          400,
        );
      }
      logger.debug(`[Synthetic] best-free resolved to: ${resolved}`);
      syntheticId = resolved;
    }

    const result = buildBackendList(syntheticId);

    if (!result) {
      throw new ProviderError(`Unknown synthetic model: ${syntheticId}`, 400);
    }

    const { backends, canonical } = result;

    if (backends.length === 0) {
      throw new ProviderError(
        `No API keys configured for any provider offering ${canonical.id}`,
        400,
      );
    }

    const now = Date.now();
    if (!this.cooldowns.has(syntheticId)) {
      this.cooldowns.set(syntheticId, new Array(backends.length).fill(0));
    }

    // Resize cooldown array if backend count changed (catalog updated)
    let cooldownArr = this.cooldowns.get(syntheticId)!;
    if (cooldownArr.length !== backends.length) {
      cooldownArr = new Array(backends.length).fill(0);
      this.cooldowns.set(syntheticId, cooldownArr);
    }

    // Reset to preferred backend if its cooldown expired
    if (cooldownArr[0] <= now) {
      this.activeBackend.set(syntheticId, 0);
    }

    const startIndex = this.activeBackend.get(syntheticId) ?? 0;
    const errors: Array<{ backend: SyntheticBackend; error: Error }> = [];
    let shortestCooldown = Infinity;

    // Try each backend in order, starting from active
    for (let i = 0; i < backends.length; i++) {
      const idx = (startIndex + i) % backends.length;
      const backend = backends[idx];

      // Skip if still in cooldown
      if (cooldownArr[idx] > now) {
        const remaining = cooldownArr[idx] - now;
        if (remaining < shortestCooldown) shortestCooldown = remaining;
        continue;
      }

      // Resolve provider
      let provider: LLMProvider;
      try {
        // registryGetter is no longer stored on the class; we resolve lazily via
        // the module-level registry to avoid circular imports at construction time.
        const { providerRegistry } = await import('./registry.ts');
        provider = providerRegistry.get(backend.providerName);
      } catch (err) {
        logger.debug(`[Synthetic] Backend ${backend.providerName} not available: ${err}`);
        continue;
      }

      // Attempt the call
      // Note: if onDelta is set and a rate limit occurs mid-stream, partial content
      // from this backend will already have been delivered to the caller. The next
      // backend starts fresh, which may produce garbled output. In practice, rate
      // limits reject before streaming begins (at the HTTP level), so this is
      // unlikely to trigger.
      try {
        const response = await provider.chat({
          ...params,
          model: backend.modelId,
        });

        // Success — update active backend
        this.activeBackend.set(syntheticId, idx);
        logger.info(`[Synthetic] ${syntheticId} served by ${backend.providerName} (${backend.modelId})`);
        return response;
      } catch (err) {
        if (isRateLimitOrQuotaError(err)) {
          // Record cooldown
          const cooldownMs = (err instanceof ProviderError && err.retryAfterMs)
            ? err.retryAfterMs
            : DEFAULT_COOLDOWN_MS;
          cooldownArr[idx] = now + cooldownMs;
          this.cooldowns.set(syntheticId, cooldownArr);

          logger.info(`[Synthetic] ${backend.providerName} rate-limited for ${syntheticId}, cooldown ${Math.round(cooldownMs / 1000)}s`);
          errors.push({ backend, error: err as Error });
          continue;
        }
        // Non-rate-limit error — don't failover, re-throw
        throw err;
      }
    }

    // All backends exhausted
    const cooldownSec = shortestCooldown === Infinity ? '?' : Math.round(shortestCooldown / 1000);
    throw new ProviderError(
      `All backends for ${syntheticId} are rate-limited. Shortest cooldown expires in ${cooldownSec}s. ` +
      `Tried: ${errors.map(e => e.backend.providerName).join(', ')}`,
      429,
    );
  }
}
