/**
 * Provider health domain state — tracks connectivity, error rates,
 * and latency for all configured LLM providers.
 */

/** Health status for a single provider. */
export type ProviderStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'rate_limited'
  | 'auth_error'
  | 'unavailable';

/** Aggregate health summary across all providers. */
export type CompositeHealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';

/** Statistics for provider call performance. */
export interface ProviderCallStats {
  /** Total API calls made. */
  totalCalls: number;
  /** Calls that succeeded. */
  successCalls: number;
  /** Calls that resulted in an error. */
  errorCalls: number;
  /** Moving average latency in ms (last 10 calls). */
  avgLatencyMs: number;
  /** Minimum observed latency in ms. */
  minLatencyMs: number;
  /** Maximum observed latency in ms. */
  maxLatencyMs: number;
  /** Time of last successful call (epoch ms). */
  lastSuccessAt?: number;
  /** Time of last error (epoch ms). */
  lastErrorAt?: number;
  /** Most recent error message. */
  lastErrorMessage?: string;
}

/** Cache hit metrics for a provider. */
export interface ProviderCacheMetrics {
  /** Cumulative cache read tokens saved. */
  cacheReadTokens: number;
  /** Cumulative cache write tokens. */
  cacheWriteTokens: number;
  /** Cache hit rate (0–1). */
  hitRate: number;
}

/** Full health record for a single provider. */
export interface ProviderHealthRecord {
  /** Provider ID. */
  providerId: string;
  /** Provider display name. */
  displayName: string;
  /** Current health status. */
  status: ProviderStatus;
  /** Whether this provider is currently the active selection. */
  isActive: boolean;
  /** Whether this provider is configured and available. */
  isConfigured: boolean;
  /** Call statistics. */
  stats: ProviderCallStats;
  /** Cache metrics (only relevant for providers that support prompt caching). */
  cacheMetrics?: ProviderCacheMetrics;
  /** Epoch ms of the last health check. */
  lastCheckedAt?: number;
  /** Rate limit reset time (epoch ms), if currently rate-limited. */
  rateLimitResetAt?: number;
}

/**
 * ProviderHealthDomainState — health monitoring for all LLM providers.
 */
export interface ProviderHealthDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Provider registry ──────────────────────────────────────────────────────
  /** All provider health records keyed by providerId. */
  providers: Map<string, ProviderHealthRecord>;

  // ── Aggregate ──────────────────────────────────────────────────────────────
  /** Composite health status across all providers. */
  compositeStatus: CompositeHealthStatus;
  /** Number of providers currently in a non-healthy state. */
  degradedCount: number;
  /** Number of providers currently unavailable. */
  unavailableCount: number;

  // ── Warnings ───────────────────────────────────────────────────────────────
  /** Warning messages from provider discovery (e.g. misconfigured keys). */
  warnings: string[];
}

/**
 * Returns the default initial state for the provider health domain.
 */
export function createInitialProviderHealthState(): ProviderHealthDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    providers: new Map(),
    compositeStatus: 'unknown',
    degradedCount: 0,
    unavailableCount: 0,
    warnings: [],
  };
}
