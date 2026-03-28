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

// --- Seed catalog ---
// Provides tier-aware, key-aware backend data for catalog-driven failover.
// Stage 1 network fetch (models.dev) will eventually replace this seed.

const SEED_CANONICAL_MODELS: CanonicalModel[] = [
  {
    id: 'gpt-oss-120b',
    tier: 'free',
    backends: [
      { providerName: 'groq',         modelId: 'openai/gpt-oss-120b',      contextWindow: 131072, envVars: ['GROQ_API_KEY'] },
      { providerName: 'huggingface',  modelId: 'openai/gpt-oss-120b',      contextWindow: 131072, envVars: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
      { providerName: 'nvidia',       modelId: 'openai/gpt-oss-120b',      contextWindow: 131072, envVars: ['NVIDIA_API_KEY'] },
      { providerName: 'ollama-cloud', modelId: 'gpt-oss:120b',             contextWindow: 131072, envVars: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY'] },
      { providerName: 'openai',       modelId: 'gpt-oss-120b',             contextWindow: 131072, envVars: ['OPENAI_API_KEY'] },
      { providerName: 'openrouter',   modelId: 'openai/gpt-oss-120b:free', contextWindow: 131072, envVars: ['OPENROUTER_API_KEY'] },
    ],
  },
  {
    id: 'minimax-m2.5',
    tier: 'free',
    backends: [
      { providerName: 'huggingface',  modelId: 'MiniMaxAI/MiniMax-M2.5',   contextWindow: 1000000, envVars: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
      { providerName: 'nvidia',       modelId: 'minimaxai/minimax-m2.5',   contextWindow: 1000000, envVars: ['NVIDIA_API_KEY'] },
      { providerName: 'ollama-cloud', modelId: 'minimax-m2.5',             contextWindow: 1000000, envVars: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY'] },
      { providerName: 'openrouter',   modelId: 'minimax/minimax-m2.5:free', contextWindow: 1000000, envVars: ['OPENROUTER_API_KEY'] },
      { providerName: 'aihubmix',     modelId: 'coding-minimax-m2.5-free', contextWindow: 1000000, envVars: ['AIHUBMIX_API_KEY'] },
      { providerName: 'aihubmix',     modelId: 'minimax-m2.5-free',        contextWindow: 1000000, envVars: ['AIHUBMIX_API_KEY'] },
    ],
  },
  {
    id: 'kimi-k2.5',
    tier: 'free',
    backends: [
      { providerName: 'huggingface',  modelId: 'moonshotai/Kimi-K2.5', contextWindow: 262144, envVars: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
      { providerName: 'nvidia',       modelId: 'moonshotai/kimi-k2.5', contextWindow: 262144, envVars: ['NVIDIA_API_KEY'] },
      { providerName: 'ollama-cloud', modelId: 'kimi-k2.5',            contextWindow: 262144, envVars: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY'] },
    ],
  },
  {
    id: 'qwen-3.5-397b',
    tier: 'free',
    backends: [
      { providerName: 'huggingface',  modelId: 'Qwen/Qwen3.5-397B-A17B',       contextWindow: 131072, envVars: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
      { providerName: 'nvidia',       modelId: 'qwen/qwen3.5-397b-a17b',       contextWindow: 131072, envVars: ['NVIDIA_API_KEY'] },
      { providerName: 'ollama-cloud', modelId: 'qwen3.5:397b',                 contextWindow: 131072, envVars: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY'] },
    ],
  },
  {
    id: 'glm-5',
    tier: 'free',
    backends: [
      { providerName: 'huggingface',  modelId: 'zai-org/GLM-5',          contextWindow: 131072, envVars: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
      { providerName: 'nvidia',       modelId: 'z-ai/glm5',              contextWindow: 131072, envVars: ['NVIDIA_API_KEY'] },
      { providerName: 'ollama-cloud', modelId: 'glm-5',                  contextWindow: 131072, envVars: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY'] },
      { providerName: 'aihubmix',     modelId: 'coding-glm-5-free',      contextWindow: 131072, envVars: ['AIHUBMIX_API_KEY'] },
      { providerName: 'aihubmix',     modelId: 'coding-glm-5-turbo-free', contextWindow: 131072, envVars: ['AIHUBMIX_API_KEY'] },
    ],
  },
  {
    id: 'nemotron-3-super-120b',
    tier: 'free',
    backends: [
      { providerName: 'nvidia',       modelId: 'nvidia/nemotron-3-super-120b-a12b',      contextWindow: 131072, envVars: ['NVIDIA_API_KEY'] },
      { providerName: 'ollama-cloud', modelId: 'nemotron-3-super',                        contextWindow: 131072, envVars: ['OLLAMA_CLOUD_API_KEY', 'OPENAI_API_KEY'] },
      { providerName: 'openrouter',   modelId: 'nvidia/nemotron-3-super-120b-a12b:free', contextWindow: 131072, envVars: ['OPENROUTER_API_KEY'] },
    ],
  },
];

// --- Injectable catalog (for tests) ---

let _overrideCatalog: CanonicalModel[] | null = null;

/**
 * Inject a custom catalog for testing.
 * @internal
 */
export function _setSyntheticCatalogForTest(catalog: CanonicalModel[]): void {
  _overrideCatalog = catalog;
}

/**
 * Reset the injected catalog back to seed data.
 * @internal
 */
export function _resetSyntheticCatalog(): void {
  _overrideCatalog = null;
}

/** Returns the active canonical model catalog. */
function getCatalogModels(): CanonicalModel[] {
  return _overrideCatalog ?? SEED_CANONICAL_MODELS;
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
