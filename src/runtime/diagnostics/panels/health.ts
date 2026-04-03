/**
 * Health diagnostic panel data provider.
 *
 * Subscribes to the RuntimeHealthAggregator and produces HealthDashboardData
 * snapshots for the health dashboard diagnostics panel.
 *
 * Implements the health visualization layer from v3 Section 18.3.
 * SLO status rows are included when an SloCollector is attached.
 */
import type { RuntimeHealthAggregator } from '../../health/aggregator.ts';
import type { CompositeHealth } from '../../health/types.ts';
import type { HealthDashboardData, DomainHealthSummary, SloRow, SloGateStatus } from '../types.ts';
import type { SloCollector } from '../../perf/slo-collector.ts';
import { SLO_METRICS } from '../../perf/slo-collector.ts';
import { DEFAULT_BUDGETS } from '../../perf/budgets.ts';

/**
 * HealthPanel — diagnostic data provider for runtime health telemetry.
 *
 * Subscribes to health aggregator updates and maintains a current
 * HealthDashboardData snapshot for the panel to render.
 */
/** Warn threshold: 20% above the SLO target triggers a 'warn' status. */
const SLO_WARN_FACTOR = 1.2;

/** SLO budget metadata needed for row construction, keyed by metric name. */
const SLO_BUDGET_META = new Map(
  DEFAULT_BUDGETS
    .filter((b) => b.metric.startsWith('slo.'))
    .map((b) => [b.metric, { name: b.name, targetMs: b.threshold }])
);

export class HealthPanel {
  private readonly _aggregator: RuntimeHealthAggregator;
  private readonly _sloCollector: SloCollector | null;
  private _current: HealthDashboardData;
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Unsubscribe function from the aggregator. */
  private _unsub: (() => void) | null = null;

  /**
   * @param aggregator - The runtime health aggregator to subscribe to.
   * @param sloCollector - Optional SLO collector for SLO status rows.
   *   When provided, SLO rows are included in every dashboard snapshot.
   */
  constructor(aggregator: RuntimeHealthAggregator, sloCollector: SloCollector | null = null) {
    this._aggregator = aggregator;
    this._sloCollector = sloCollector;
    // Capture the initial snapshot before subscribing
    this._current = this._buildDashboard(aggregator.getCompositeHealth());
    this._unsub = aggregator.subscribe((health) => {
      this._current = this._buildDashboard(health);
      this._notify();
    });
  }

  /**
   * Build a HealthDashboardData snapshot from a CompositeHealth record.
   */
  private _buildDashboard(composite: CompositeHealth): HealthDashboardData {
    const domains: DomainHealthSummary[] = [];
    for (const [, dh] of composite.domains) {
      domains.push({
        domain: dh.domain,
        status: dh.status,
        lastTransitionAt: dh.lastTransitionAt,
        degradedCapabilities: dh.degradedCapabilities ?? [],
        failureReason: dh.failureReason,
        recoveryAttempts: dh.recoveryAttempts,
      });
    }
    // Sort: failed first, then degraded, then healthy, alphabetically within tier
    domains.sort((a, b) => {
      const order = { failed: 0, degraded: 1, healthy: 2, unknown: 3 };
      const diff = (order[a.status] ?? 3) - (order[b.status] ?? 3);
      return diff !== 0 ? diff : a.domain.localeCompare(b.domain);
    });
    return {
      overall: composite.overall,
      domains,
      degradedDomains: composite.degradedDomains,
      failedDomains: composite.failedDomains,
      lastUpdatedAt: composite.lastUpdatedAt,
      sloRows: this._buildSloRows(),
    };
  }

  /**
   * Build SLO status rows from the current SloCollector snapshot.
   * Returns an empty array when no SloCollector is attached.
   */
  private _buildSloRows(): SloRow[] {
    if (this._sloCollector === null) return [];

    const metrics = this._sloCollector.getMetrics();
    const counts = this._sloCollector.getSampleCounts();

    const SLO_ORDER = [
      SLO_METRICS.TURN_START,
      SLO_METRICS.CANCEL,
      SLO_METRICS.RECONNECT_RECOVERY,
      SLO_METRICS.PERMISSION_DECISION,
    ] as const;

    return SLO_ORDER.map((metricKey): SloRow => {
      const metric = metrics.find((m) => m.name === metricKey);
      const meta = SLO_BUDGET_META.get(metricKey);
      const p95Ms = metric?.value ?? 0;
      const targetMs = meta?.targetMs ?? 0;
      const sampleCount = counts[metricKey] ?? 0;

      let status: SloGateStatus;
      if (sampleCount === 0) {
        status = 'no_data';
      } else if (p95Ms > targetMs) {
        status = 'violated';
      } else if (p95Ms > targetMs / SLO_WARN_FACTOR) {
        status = 'warn';
      } else {
        status = 'ok';
      }

      return {
        metric: metricKey,
        name: meta?.name ?? metricKey,
        p95Ms,
        targetMs,
        sampleCount,
        status,
      };
    });
  }

  /**
   * Return the current health dashboard snapshot.
   * This is updated synchronously when the aggregator fires.
   */
  public getSnapshot(): HealthDashboardData {
    return this._current;
  }

  /**
   * Register a callback invoked whenever health data changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release the aggregator subscription.
   */
  public dispose(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._subscribers.clear();
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
