/**
 * Health diagnostic panel data provider.
 *
 * Subscribes to the RuntimeHealthAggregator and produces HealthDashboardData
 * snapshots for the health dashboard diagnostics panel.
 *
 * Implements the health visualization layer from v3 Section 18.3.
 */
import type { RuntimeHealthAggregator } from '../../health/aggregator.ts';
import type { CompositeHealth } from '../../health/types.ts';
import type { HealthDashboardData, DomainHealthSummary } from '../types.ts';

/**
 * HealthPanel — diagnostic data provider for runtime health telemetry.
 *
 * Subscribes to health aggregator updates and maintains a current
 * HealthDashboardData snapshot for the panel to render.
 */
export class HealthPanel {
  private readonly _aggregator: RuntimeHealthAggregator;
  private _current: HealthDashboardData;
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Unsubscribe function from the aggregator. */
  private _unsub: (() => void) | null = null;

  constructor(aggregator: RuntimeHealthAggregator) {
    this._aggregator = aggregator;
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
    };
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
