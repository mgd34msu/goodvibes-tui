/**
 * Provider health UI data types.
 *
 * Purely data-oriented — no rendering logic. These types are produced by
 * ProviderHealthDataProvider and consumed by renderers/components.
 */
import type { ProviderStatus, CompositeHealthStatus } from '../../store/domains/provider-health.ts';

// Re-exports for convenience
export type { ProviderStatus, CompositeHealthStatus };

/**
 * A single point in a provider health timeline.
 * Used to render charts of success rate, latency, or error rate over time.
 */
export interface HealthTimelinePoint {
  /** Epoch ms timestamp of this sample. */
  readonly ts: number;
  /** Observed success rate at this point (0–1). */
  readonly successRate: number;
  /** Observed average latency in ms at this point. */
  readonly avgLatencyMs: number;
  /** Observed error rate at this point (0–1). */
  readonly errorRate: number;
}

/**
 * Timeline data for a single provider, for chart rendering.
 */
export interface HealthTimeline {
  /** Provider ID this timeline belongs to. */
  readonly providerId: string;
  /** Ordered timeline points (oldest first). */
  readonly points: readonly HealthTimelinePoint[];
  /** The number of points retained in this timeline. */
  readonly length: number;
}

/**
 * Full health entry for a single provider, enriched for UI consumption.
 */
export interface ProviderHealthEntry {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** Provider identifier. */
  readonly providerId: string;
  /** Human-readable provider name. */
  readonly displayName: string;

  // ── Status ────────────────────────────────────────────────────────────────
  /** Current health status. */
  readonly status: ProviderStatus;
  /** True when this provider is the active selection. */
  readonly isActive: boolean;
  /** True when this provider is configured with a valid API key. */
  readonly isConfigured: boolean;

  // ── Performance metrics ───────────────────────────────────────────────────
  /** Success rate (0–1), derived from totalCalls and successCalls. */
  readonly successRate: number;
  /** Error rate (0–1), derived from totalCalls and errorCalls. */
  readonly errorRate: number;
  /** Approximate p95 latency in ms (max of recent observations). */
  readonly p95LatencyMs: number;
  /** Moving average latency in ms. */
  readonly avgLatencyMs: number;
  /** Total API calls recorded. */
  readonly totalCalls: number;

  // ── Cache metrics ─────────────────────────────────────────────────────────
  /** Cache hit rate (0–1). Present only when cache metrics are available. */
  readonly cacheHitRate?: number;
  /** Cumulative cache read tokens saved. */
  readonly cacheReadTokens?: number;
  /** Cumulative cache write tokens. */
  readonly cacheWriteTokens?: number;

  // ── Timing ────────────────────────────────────────────────────────────────
  /** Epoch ms of the last successful call, if any. */
  readonly lastSuccessAt?: number;
  /** Epoch ms of the last error, if any. */
  readonly lastErrorAt?: number;
  /** Most recent error message, if any. */
  readonly lastErrorMessage?: string;
  /** Epoch ms of the last health check. */
  readonly lastCheckedAt?: number;
  /** Rate limit reset time (epoch ms), if currently rate-limited. */
  readonly rateLimitResetAt?: number;

  // ── Timeline ──────────────────────────────────────────────────────────────
  /** Timeline data for chart rendering. */
  readonly timeline: HealthTimeline;
}

/**
 * A single node in the fallback chain visualization.
 */
export interface FallbackChainNode {
  /** Provider identifier. */
  readonly providerId: string;
  /** Model identifier on this provider. */
  readonly modelId: string;
  /** Human-readable display label. */
  readonly displayName: string;
  /** Position in the chain (0 = primary). */
  readonly position: number;
  /** Whether this node is the currently active entry in the chain. */
  readonly isCurrent: boolean;
  /** Current health status of this provider. */
  readonly providerStatus: ProviderStatus;
  /** Reason this fallback was configured. */
  readonly reason?: string;
}

/**
 * Fallback chain visualization data for the current model configuration.
 */
export interface FallbackChainData {
  /** Ordered nodes in the fallback chain (primary first). */
  readonly nodes: readonly FallbackChainNode[];
  /** Index of the currently active node (-1 = primary is active). */
  readonly activeIndex: number;
  /** Number of fallover events since session start. */
  readonly falloverCount: number;
  /** True when the chain has at least one degraded or unavailable node. */
  readonly hasUnhealthyNode: boolean;
}

/**
 * Complete data snapshot produced by ProviderHealthDataProvider.
 */
export interface ProviderHealthData {
  /** All provider health entries, sorted by status priority then name. */
  readonly entries: readonly ProviderHealthEntry[];
  /** Composite health status across all providers. */
  readonly compositeStatus: CompositeHealthStatus;
  /** Number of providers currently in a non-healthy state. */
  readonly degradedCount: number;
  /** Number of providers currently unavailable. */
  readonly unavailableCount: number;
  /** Fallback chain visualization data. */
  readonly fallbackChain: FallbackChainData;
  /** Warning messages from provider discovery. */
  readonly warnings: readonly string[];
  /** Epoch ms when this snapshot was produced. */
  readonly snapshotAt: number;
}
