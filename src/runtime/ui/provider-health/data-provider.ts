/**
 * ProviderHealthDataProvider — enriched provider health data surface.
 *
 * Combines ProviderHealthDomainState and ModelDomainState into a single,
 * sorted ProviderHealthData snapshot for UI consumption.
 *
 * This class is a data provider only — it contains no rendering logic.
 * Subscribe to change notifications and call getSnapshot() to render.
 */
import type { ProviderHealthDomainState, ProviderHealthRecord } from '../../store/domains/provider-health.ts';
import type { ModelDomainState } from '../../store/domains/model.ts';
import { buildFallbackChainData } from './fallback-visualizer.ts';
import type {
  ProviderHealthData,
  ProviderHealthEntry,
  HealthTimeline,
  HealthTimelinePoint,
} from './types.ts';

/**
 * Number of timeline points retained per provider.
 * Each point represents a snapshot at the time of a state update.
 */
const TIMELINE_MAX_POINTS = 60;

/** Status sort priority (lower = shown first in list). */
const STATUS_ORDER: Record<string, number> = {
  degraded: 0,
  rate_limited: 1,
  auth_error: 2,
  unavailable: 3,
  unknown: 4,
  healthy: 5,
};

/**
 * Internal mutable timeline buffer for a provider.
 */
interface TimelineBuffer {
  readonly points: HealthTimelinePoint[];
}

/**
 * ProviderHealthDataProvider produces enriched provider health data snapshots.
 *
 * Usage:
 * ```ts
 * const provider = new ProviderHealthDataProvider(healthState, modelState);
 * const unsub = provider.subscribe(() => {
 *   const data = provider.getSnapshot();
 *   // render data.entries, data.fallbackChain, etc.
 * });
 * // When state changes:
 * provider.updateHealthState(newHealthState);
 * provider.updateModelState(newModelState);
 * // Cleanup:
 * unsub();
 * provider.dispose();
 * ```
 */
export class ProviderHealthDataProvider {
  private _healthState: ProviderHealthDomainState;
  private _modelState: ModelDomainState;
  private _snapshot: ProviderHealthData;
  private readonly _subscribers = new Set<() => void>();
  /** Per-provider timeline buffers, keyed by providerId. */
  private readonly _timelines = new Map<string, TimelineBuffer>();

  constructor(healthState: ProviderHealthDomainState, modelState: ModelDomainState) {
    this._healthState = healthState;
    this._modelState = modelState;
    this._seedTimelines(healthState);
    this._snapshot = this._buildSnapshot();
  }

  /**
   * Return the current enriched provider health data snapshot.
   * Updated synchronously when state changes via update methods.
   */
  public getSnapshot(): ProviderHealthData {
    return this._snapshot;
  }

  /**
   * Register a callback invoked whenever the snapshot changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Update provider health state and rebuild the snapshot.
   * Appends a new timeline point for each provider.
   */
  public updateHealthState(healthState: ProviderHealthDomainState): void {
    this._healthState = healthState;
    this._appendTimelinePoints(healthState);
    this._rebuild();
  }

  /**
   * Update model domain state (e.g. active model or fallback chain change).
   * Triggers a snapshot rebuild.
   */
  public updateModelState(modelState: ModelDomainState): void {
    this._modelState = modelState;
    this._rebuild();
  }

  /**
   * Release all subscriber references.
   * Does not clear internal state — getSnapshot() remains usable after disposal.
   */
  public dispose(): void {
    this._subscribers.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Seed timeline buffers from the initial health state.
   * Appends one point per known provider to initialize the timeline.
   */
  private _seedTimelines(healthState: ProviderHealthDomainState): void {
    for (const [id, record] of healthState.providers) {
      const buffer: TimelineBuffer = { points: [] };
      this._timelines.set(id, buffer);
      this._appendPoint(buffer, record);
    }
  }

  /**
   * Append a new timeline point for every provider in the updated state.
   * Creates a new buffer for providers seen for the first time.
   */
  private _appendTimelinePoints(healthState: ProviderHealthDomainState): void {
    for (const [id, record] of healthState.providers) {
      if (!this._timelines.has(id)) {
        this._timelines.set(id, { points: [] });
      }
      this._appendPoint(this._timelines.get(id)!, record);
    }
  }

  /** Append a single timeline point to a buffer, capping at TIMELINE_MAX_POINTS. */
  private _appendPoint(buffer: TimelineBuffer, record: ProviderHealthRecord): void {
    const total = record.stats.totalCalls;
    const successRate = total > 0 ? record.stats.successCalls / total : 1;
    const errorRate = total > 0 ? record.stats.errorCalls / total : 0;

    buffer.points.push({
      ts: Date.now(),
      successRate,
      avgLatencyMs: record.stats.avgLatencyMs,
      errorRate,
    });

    if (buffer.points.length > TIMELINE_MAX_POINTS) {
      // Array.shift() is O(n) but acceptable: TIMELINE_MAX_POINTS is capped at 60,
      // so the cost is negligible and the simplicity outweighs a ring-buffer implementation.
      buffer.points.shift();
    }
  }

  /** Build a HealthTimeline from a buffer for a given provider. */
  private _buildTimeline(providerId: string): HealthTimeline {
    const buffer = this._timelines.get(providerId);
    const points: readonly HealthTimelinePoint[] = buffer ? [...buffer.points] : [];
    return {
      providerId,
      points,
      length: points.length,
    };
  }

  private _rebuild(): void {
    this._snapshot = this._buildSnapshot();
    this._notify();
  }

  private _buildSnapshot(): ProviderHealthData {
    const entries: ProviderHealthEntry[] = [];

    for (const [id, record] of this._healthState.providers) {
      const total = record.stats.totalCalls;
      const successRate = total > 0 ? record.stats.successCalls / total : 1;
      const errorRate = total > 0 ? record.stats.errorCalls / total : 0;

      entries.push({
        providerId: id,
        displayName: record.displayName,
        status: record.status,
        isActive: record.isActive,
        isConfigured: record.isConfigured,
        successRate,
        errorRate,
        p95LatencyMs: record.stats.maxLatencyMs,
        avgLatencyMs: record.stats.avgLatencyMs,
        totalCalls: total,
        // cacheHitRate is populated only when cache-capability is wired to the provider record.
        // Until then this will always be undefined — intentionally unsupported at this stage.
        cacheHitRate: record.cacheMetrics?.hitRate,
        cacheReadTokens: record.cacheMetrics?.cacheReadTokens,
        cacheWriteTokens: record.cacheMetrics?.cacheWriteTokens,
        lastSuccessAt: record.stats.lastSuccessAt,
        lastErrorAt: record.stats.lastErrorAt,
        lastErrorMessage: record.stats.lastErrorMessage,
        lastCheckedAt: record.lastCheckedAt,
        rateLimitResetAt: record.rateLimitResetAt,
        timeline: this._buildTimeline(id),
      });
    }

    // Sort: degraded/unavailable first (needs attention), then healthy, then unknown
    entries.sort((a, b) => {
      const diff = (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4);
      return diff !== 0 ? diff : a.displayName.localeCompare(b.displayName);
    });

    const fallbackChain = buildFallbackChainData(this._modelState, this._healthState);

    return {
      entries,
      compositeStatus: this._healthState.compositeStatus,
      degradedCount: this._healthState.degradedCount,
      unavailableCount: this._healthState.unavailableCount,
      fallbackChain,
      warnings: this._healthState.warnings,
      snapshotAt: Date.now(),
    };
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Non-fatal: subscriber errors must not crash the provider
      }
    }
  }
}
