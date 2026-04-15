import type { LLMProvider, ChatRequest, ChatResponse } from '@pellux/goodvibes-sdk/platform/providers/interface';
import { ProviderError, isRateLimitOrQuotaError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import { compositeScore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { emitModelFallback } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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
  /** Total number of provider backends offering this model. */
  backendCount: number;
  /** Number of backends for which the user has configured API keys. */
  keyedBackendCount: number;
}

type SyntheticCatalogAccessor = () => readonly CanonicalModel[];
type BenchmarkLookup = (modelId: string) => BenchmarkEntry | undefined;

/**
 * Returns backend count metadata for a synthetic model ID.
 * Used by the model picker to display provider availability.
 *
 * @returns Object with backendCount, keyedBackendCount, and tier, or null if not found.
 */
export function getSyntheticModelInfo(
  modelId: string,
  getCatalogModels: SyntheticCatalogAccessor,
): { backendCount: number; keyedBackendCount: number; tier: SyntheticTier } | null {
  const catalog = [...getCatalogModels()];
  const model = catalog.find(m => m.id === modelId);
  if (!model) return null;
  return {
    backendCount: model.backendCount,
    keyedBackendCount: model.keyedBackendCount,
    tier: model.tier,
  };
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
  getCatalogModels: SyntheticCatalogAccessor,
): { backends: SyntheticBackend[]; canonical: CanonicalModel } | null {
  const catalog = [...getCatalogModels()];
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

function bestCompositeScoreForModelWithLookup(
  model: CanonicalModel,
  getBenchmarks: BenchmarkLookup,
): number {
  let best = -1;
  for (const b of model.backends) {
    const entry = getBenchmarks(b.modelId);
    if (entry) {
      const score = compositeScore(entry.benchmarks);
      if (score !== null && score > best) best = score;
    }
  }
  return best;
}

/**
 * Resolve 'best-free' to the canonical ID of the highest composite-scored
 * free model for which the user has at least one backend key configured.
 *
 * Returns null if no free models have keys or benchmark data.
 */
function resolveBestFree(
  getCatalogModels: SyntheticCatalogAccessor,
  getBenchmarks: BenchmarkLookup,
): string | null {
  const catalog = [...getCatalogModels()];
  const freeModels = catalog.filter(m => m.tier === 'free');

  let bestId: string | null = null;
  let bestScore = -Infinity;

  for (const model of freeModels) {
    // Check if any backend for this model has a key
    const hasAnyKey = model.backends.some(hasKey);
    if (!hasAnyKey) continue;

    const effectiveScore = bestCompositeScoreForModelWithLookup(model, getBenchmarks);

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestId = model.id;
    }
  }

  return bestId;
}

/**
 * Resolve the next-best free model by benchmark score, excluding models in `excludeIds`.
 * Returns the canonical model ID or null if no alternatives exist.
 */
function resolveNextBestFree(
  excludeIds: Set<string>,
  getCatalogModels: SyntheticCatalogAccessor,
  getBenchmarks: BenchmarkLookup,
): string | null {
  const catalog = [...getCatalogModels()];
  const freeModels = catalog.filter(m => m.tier === 'free' && !excludeIds.has(m.id));

  let bestId: string | null = null;
  let bestScore = -Infinity;

  for (const model of freeModels) {
    const hasAnyKey = model.backends.some(hasKey);
    if (!hasAnyKey) continue;

    const effectiveScore = bestCompositeScoreForModelWithLookup(model, getBenchmarks);

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestId = model.id;
    }
  }

  return bestId;
}

// --- Default cooldown ---
const DEFAULT_COOLDOWN_MS = 60_000;

/** Short cooldown applied to a backend that returns a transient/server error (5xx, network, timeout). */
const TRANSIENT_COOLDOWN_MS = 5_000;

/**
 * Maximum duration to transparently wait for a cooling-down backend before
 * surfacing a 429 error to the caller. Waits of up to 2 minutes are hidden;
 * longer cooldowns are escalated immediately.
 */
const MAX_AUTO_WAIT_MS = 120_000;

/** Buffer added to the computed wait time to absorb clock skew and scheduling jitter. */
const COOLDOWN_BUFFER_MS = 100;

// --- SyntheticProvider ---

export class SyntheticProvider implements LLMProvider {
  readonly name = 'synthetic';
  private readonly getCatalogModels: SyntheticCatalogAccessor;
  private readonly getBenchmarks: BenchmarkLookup;
  private readonly runtimeBus: RuntimeEventBus | null;

  /** Returns a live snapshot of canonical model IDs each time it is accessed. */
  get models(): string[] {
    return [
      ...this.getCatalogModels().map(m => m.id),
      'best-free',
    ];
  }

  // Track cooldowns: syntheticModelId -> array of expiresAt timestamps indexed by resolved backend position
  private cooldowns = new Map<string, number[]>();
  // Track active backend index per resolved model ID
  private activeBackend = new Map<string, number>();
  private readonly resolveProvider: (providerName: string) => LLMProvider;

  constructor(options: {
    resolveProvider: (providerName: string) => LLMProvider;
    getCatalogModels: SyntheticCatalogAccessor;
    getBenchmarks: BenchmarkLookup;
    runtimeBus?: RuntimeEventBus | null;
  }) {
    this.resolveProvider = options.resolveProvider;
    this.getCatalogModels = options.getCatalogModels;
    this.getBenchmarks = options.getBenchmarks;
    this.runtimeBus = options.runtimeBus ?? null;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    let syntheticId = params.model;

    // Resolve 'best-free' alias
    if (syntheticId === 'best-free') {
      const resolved = resolveBestFree(this.getCatalogModels, this.getBenchmarks);
      if (!resolved) {
        throw new ProviderError(
          'No API keys configured for any provider offering free models',
          {
            statusCode: 400,
            provider: this.name,
            operation: 'chat',
            phase: 'routing',
          },
        );
      }
      logger.debug(`[Synthetic] best-free resolved to: ${resolved}`);
      syntheticId = resolved;
    }

    const result = buildBackendList(syntheticId, this.getCatalogModels);

    if (!result) {
      throw new ProviderError(`Unknown synthetic model: ${syntheticId}`, {
        statusCode: 400,
        provider: this.name,
        operation: 'chat',
        phase: 'routing',
      });
    }

    const { backends, canonical } = result;

    if (backends.length === 0) {
      throw new ProviderError(
        `No API keys configured for any provider offering ${canonical.id}`,
        {
          statusCode: 400,
          provider: this.name,
          operation: 'chat',
          phase: 'routing',
        },
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
        provider = this.resolveProvider(backend.providerName);
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
          if (cooldownMs < shortestCooldown) shortestCooldown = cooldownMs;

          logger.info(`[Synthetic] ${backend.providerName} rate-limited for ${syntheticId}, cooldown ${Math.round(cooldownMs / 1000)}s`);
          errors.push({ backend, error: err as Error });
          continue;
        }
        // 400 Bad Request — the request itself is malformed, no point trying other backends
        const isBadRequest = err instanceof ProviderError
          && err.statusCode === 400;

        if (isBadRequest) {
          throw err;
        }

        // Other client errors (401 auth, 403 billing/forbidden, 404 model not found, etc.)
        // are provider-specific — failover to next backend with long cooldown
        const isProviderClientError = err instanceof ProviderError
          && err.statusCode !== undefined
          && err.statusCode > 400
          && err.statusCode < 500;

        if (isProviderClientError) {
          cooldownArr[idx] = now + DEFAULT_COOLDOWN_MS;
          this.cooldowns.set(syntheticId, cooldownArr);
          if (DEFAULT_COOLDOWN_MS < shortestCooldown) shortestCooldown = DEFAULT_COOLDOWN_MS;
          logger.info(`[Synthetic] ${backend.providerName} returned ${(err as ProviderError).statusCode} for ${syntheticId}, trying next backend`);
          errors.push({ backend, error: err as Error });
          continue;
        }

        // Transient/server error — short cooldown, failover to next backend
        cooldownArr[idx] = now + TRANSIENT_COOLDOWN_MS;
        this.cooldowns.set(syntheticId, cooldownArr);
        if (TRANSIENT_COOLDOWN_MS < shortestCooldown) shortestCooldown = TRANSIENT_COOLDOWN_MS;
        logger.debug(`[Synthetic] ${backend.providerName} failed for ${syntheticId}: ${summarizeError(err) ?? err}, trying next backend`);
        errors.push({ backend, error: err as Error });
        continue;
      }
    }

    // All backends exhausted — auto-wait if the shortest cooldown is within threshold
    if (shortestCooldown !== Infinity && shortestCooldown <= MAX_AUTO_WAIT_MS) {
      // Find the backend index with the shortest remaining cooldown
      const nowForWait = Date.now();
      let waitIdx = 0;
      let minExpiry = Infinity;
      for (let i = 0; i < cooldownArr.length; i++) {
        if (cooldownArr[i] > nowForWait && cooldownArr[i] < minExpiry) {
          minExpiry = cooldownArr[i];
          waitIdx = i;
        }
      }
      const waitBackend = backends[waitIdx];
      const waitMs = minExpiry - nowForWait;

      logger.debug(
        `[Synthetic] All backends cooling down for ${syntheticId}, auto-waiting ${
          Math.round(waitMs / 1000)
        }s for ${waitBackend.providerName}…`,
      );

      // Wait with AbortSignal support
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new ProviderError('Request aborted during cooldown wait', {
            statusCode: 499,
            provider: this.name,
            operation: 'chat',
            phase: 'cooldown',
          }));
        };
        const timer = setTimeout(() => {
          if (params.signal) params.signal.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs + COOLDOWN_BUFFER_MS);
        if (params.signal) {
          if (params.signal.aborted) {
            clearTimeout(timer);
            reject(new ProviderError('Request aborted during cooldown wait', {
              statusCode: 499,
              provider: this.name,
              operation: 'chat',
              phase: 'cooldown',
            }));
            return;
          }
          params.signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      // Single retry attempt on the backend that just came off cooldown
      try {
        const waitProvider = this.resolveProvider(waitBackend.providerName);
        const response = await waitProvider.chat({
          ...params,
          model: waitBackend.modelId,
        });
        this.activeBackend.set(syntheticId, waitIdx);
        logger.info(
          `[Synthetic] ${syntheticId} served by ${waitBackend.providerName} (${waitBackend.modelId}) after auto-wait`,
        );
        return response;
      } catch (retryErr) {
        // Retry failed — fall through to throw below
        logger.debug(
          `[Synthetic] Auto-wait retry failed for ${syntheticId} via ${
            waitBackend.providerName
          }: ${retryErr}`,
        );
      }
    }

    // All backends exhausted (or cooldown exceeded threshold, or retry failed)
    const cooldownSec = shortestCooldown === Infinity ? '?' : Math.round(shortestCooldown / 1000);

    // Cross-model failover for free tier only
    if (canonical.tier === 'free') {
      const tried = new Set<string>([syntheticId]);
      let fallbackId = resolveNextBestFree(tried, this.getCatalogModels, this.getBenchmarks);

      while (fallbackId) {
        tried.add(fallbackId);
        const fallbackResult = buildBackendList(fallbackId, this.getCatalogModels);
        if (!fallbackResult || fallbackResult.backends.length === 0) {
          fallbackId = resolveNextBestFree(tried, this.getCatalogModels, this.getBenchmarks);
          continue;
        }

        for (const backend of fallbackResult.backends) {
          try {
            const provider = this.resolveProvider(backend.providerName);
            const response = await provider.chat({
              ...params,
              model: backend.modelId,
            });

            this.activeBackend.set(fallbackId, 0);
            logger.info(`[Synthetic] ${syntheticId} exhausted, fell back to ${fallbackId} via ${backend.providerName}`);

            if (this.runtimeBus) {
              try {
                emitModelFallback(this.runtimeBus, {
                  sessionId: 'system',
                  traceId: `synthetic:fallback:${syntheticId}:${fallbackId}`,
                  source: 'synthetic-provider',
                }, {
                  from: syntheticId,
                  to: fallbackId,
                  provider: backend.providerName,
                });
              } catch (e) {
                logger.debug('[Synthetic] runtime bus emit failed', { error: summarizeError(e) });
              }
            }

            return response;
          } catch (err) {
            logger.debug(`[Synthetic] Fallback ${fallbackId} via ${backend.providerName} failed: ${summarizeError(err)}`);
            continue;
          }
        }

        // All backends for this fallback exhausted, try next model
        fallbackId = resolveNextBestFree(tried, this.getCatalogModels, this.getBenchmarks);
      }

      // All free models exhausted
      throw new ProviderError(
        `All free models exhausted. No alternatives available. Last tried: ${[...tried].join(', ')}`,
        {
          statusCode: 429,
          provider: this.name,
          operation: 'chat',
          phase: 'routing',
        },
      );
    }

    throw new ProviderError(
      `All backends for ${syntheticId} exhausted. Shortest cooldown expires in ${cooldownSec}s. ` +
      `Tried: ${errors.map(e => `${e.backend.providerName} (${e.error.message})`).join(', ')}`,
      {
        statusCode: 429,
        provider: this.name,
        operation: 'chat',
        phase: 'routing',
      },
    );
  }
}
