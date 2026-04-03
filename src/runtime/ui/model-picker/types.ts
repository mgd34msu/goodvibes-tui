/**
 * Model picker UI data types.
 *
 * Purely data-oriented — no rendering logic. These types are produced by
 * ModelPickerDataProvider and consumed by renderers/components.
 */
import type { ProviderStatus } from '../../store/domains/provider-health.ts';
import type { ModelFamily, CategoryFilter } from '../../../input/model-picker.ts';

// Re-export for convenience
export type { ProviderStatus };

/**
 * Capability flags indicating what a model can do.
 */
export interface CapabilityFlags {
  /** Model supports extended reasoning / chain-of-thought. */
  readonly reasoning: boolean;
  /** Model supports prompt caching. */
  readonly caching: boolean;
  /** Model supports tool/function calling. */
  readonly toolCalling: boolean;
  /** Model supports vision/multimodal inputs. */
  readonly multimodal: boolean;
  /** Model supports code editing operations. */
  readonly codeEditing: boolean;
}

/**
 * Latency statistics for a provider, derived from health telemetry.
 */
export interface ProviderLatencyStats {
  /** Moving average latency in ms (last N calls). */
  readonly avgMs: number;
  /** Approximate 95th-percentile latency in ms (max of recent observations). */
  readonly p95Ms: number;
  /** Minimum observed latency in ms. */
  readonly minMs: number;
}

/**
 * Health context for a single provider, enriched into model picker entries.
 */
export interface ProviderHealthContext {
  /** Current health status of the provider. */
  readonly status: ProviderStatus;
  /** Latency stats. Present only when the provider has call history. */
  readonly latency?: ProviderLatencyStats;
  /** Cache hit rate (0–1). Present only when cache metrics are available. */
  readonly cacheHitRate?: number;
  /** True when the provider is configured with a valid API key. */
  readonly isConfigured: boolean;
  /** Rate limit reset time (epoch ms), if the provider is currently rate-limited. */
  readonly rateLimitResetAt?: number;
}

/**
 * A single entry in the model picker list, enriched with health and benchmark data.
 */
export interface ModelPickerEntry {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** Unique model identifier. */
  readonly modelId: string;
  /** Provider identifier. */
  readonly providerId: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Model family (GPT, Claude, Gemini, …). */
  readonly family: ModelFamily;
  /** Pricing tier bucket. */
  readonly pricingTier: CategoryFilter;

  // ── Quality ───────────────────────────────────────────────────────────────
  /** Quality tier badge (S/A/B/C), derived from benchmark composite score. */
  readonly qualityTier?: string;
  /** Benchmark composite score (0–1). */
  readonly benchmarkScore?: number;

  // ── Capabilities ──────────────────────────────────────────────────────────
  /** Capability flags for this model. */
  readonly capabilities: CapabilityFlags;

  // ── Health ────────────────────────────────────────────────────────────────
  /** Health context for the model's provider. */
  readonly health: ProviderHealthContext;

  // ── Context window ─────────────────────────────────────────────────────
  /**
   * Effective context window in tokens.
   * Use this for display and budgeting — it is the authoritative value.
   */
  readonly contextWindow: number;
  /**
   * How `contextWindow` was determined.
   * - `provider_api`   — reported by the provider's /v1/models endpoint
   * - `configured_cap` — set explicitly in the provider config file
   * - `fallback`       — default constant (no config or API source)
   * - `openrouter`     — sourced from OpenRouter model data (built-in catalog models)
   * - `registry`       — static value in the built-in model registry
   */
  readonly contextWindowSource:
    | 'provider_api'
    | 'configured_cap'
    | 'fallback'
    | 'openrouter'
    | 'registry';

  // ── Display state ─────────────────────────────────────────────────────────
  /** True if this model is in the user's favorites/pinned list. */
  readonly isPinned: boolean;
  /** True if this is the currently active model. */
  readonly isActive: boolean;
  /** True when the provider is currently in a degraded or critical state. */
  readonly isProviderDegraded: boolean;
  /** True when the provider is unavailable or in auth error. */
  readonly isProviderUnavailable: boolean;
  /** True if this model is part of the current fallback chain. */
  readonly isInFallbackChain: boolean;
  /** Position in the fallback chain (0 = primary, 1+ = fallback index). */
  readonly fallbackPosition?: number;
}

/**
 * A visual group in the model picker list.
 */
export interface ModelPickerGroup {
  /** Group label (e.g. provider name, family name, quality tier). */
  readonly label: string;
  /** Entries belonging to this group, sorted by health then favorites. */
  readonly entries: readonly ModelPickerEntry[];
}

/**
 * Complete data snapshot produced by ModelPickerDataProvider.
 */
export interface ModelPickerData {
  /** All enriched model entries (flat, pre-sorted). */
  readonly entries: readonly ModelPickerEntry[];
  /** Grouped view for rendering with section headers. */
  readonly groups: readonly ModelPickerGroup[];
  /** IDs of providers that are currently degraded. */
  readonly degradedProviderIds: readonly string[];
  /** IDs of providers that are currently unavailable. */
  readonly unavailableProviderIds: readonly string[];
  /** Model ID currently at the head of the fallback chain (active model). */
  readonly activeModelId: string;
  /** Epoch ms when this snapshot was produced. */
  readonly snapshotAt: number;
}
