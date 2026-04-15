/**
 * Health diagnostic panel data provider.
 *
 * Subscribes to the RuntimeHealthAggregator and produces HealthDashboardData
 * snapshots for the health dashboard diagnostics panel.
 *
 * Implements the health visualization layer for diagnostics.
 * SLO status rows are included when an SloCollector is attached.
 * Remediation actions are included when a CascadeTimer is attached.
 */
import type { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
import type { CompositeHealth, HealthDomain, HealthStatus } from '@pellux/goodvibes-sdk/platform/runtime/health/types';
import type { HealthDashboardData, DomainHealthSummary, SloRow, SloGateStatus, RemediationAction } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';
import type { SloCollector } from '../../perf/slo-collector.ts';
import type { CascadeTimer } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-timing';
import { SLO_METRICS } from '../../perf/slo-collector.ts';
import { DEFAULT_BUDGETS } from '@pellux/goodvibes-sdk/platform/runtime/perf/budgets';

/**
 * Human-readable names for playbooks, keyed by playbook ID.
 * Used to populate RemediationAction.playbookName in the health dashboard.
 */
const PLAYBOOK_NAMES: ReadonlyMap<string, string> = new Map([
  ['stuck-turn', 'Stuck Turn / Task'],
  ['reconnect-failure', 'Reconnect Failure'],
  ['permission-deadlock', 'Permission Deadlock'],
  ['plugin-degradation', 'Plugin Degradation'],
  ['export-recovery', 'Export Recovery'],
  ['session-unrecoverable', 'Session Unrecoverable'],
  ['compaction-failure', 'Compaction Failure'],
]);

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
  private readonly _cascadeTimer: CascadeTimer | null;
  private _current: HealthDashboardData;
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Unsubscribe function from the aggregator. */
  private _unsub: (() => void) | null = null;

  /**
   * @param aggregator - The runtime health aggregator to subscribe to.
   * @param sloCollector - Optional SLO collector for SLO status rows.
   *   When provided, SLO rows are included in every dashboard snapshot.
   * @param cascadeTimer - Optional CascadeTimer for remediation action rows.
   *   When provided, active failed domains are evaluated and remediation
   *   playbook IDs are surfaced in every dashboard snapshot.
   */
  constructor(
    aggregator: RuntimeHealthAggregator,
    sloCollector: SloCollector | null = null,
    cascadeTimer: CascadeTimer | null = null,
  ) {
    this._aggregator = aggregator;
    this._sloCollector = sloCollector;
    this._cascadeTimer = cascadeTimer;
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
      remediationActions: this._buildRemediationActions(composite),
    };
  }

  /**
   * Build remediation action rows by evaluating cascade rules for all
   * currently-failed domains using the CascadeTimer.
   *
   * Returns an empty array when no CascadeTimer is attached or when
   * no domains are in the failed state.
   */
  private _buildRemediationActions(composite: CompositeHealth): readonly RemediationAction[] {
    if (this._cascadeTimer === null || composite.failedDomains.length === 0) {
      return [];
    }

    const actions: RemediationAction[] = [];
    const seen = new Set<string>(); // deduplicate by playbookId+ruleId

    for (const domain of composite.failedDomains) {
      const { cascades } = this._cascadeTimer.evaluate(
        domain,
        'failed',
      );

      for (const cascade of cascades) {
        for (const playbookId of cascade.remediationPlaybookIds) {
          const key = `${playbookId}:${cascade.ruleId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          actions.push({
            playbookId,
            playbookName: PLAYBOOK_NAMES.get(playbookId) ?? playbookId,
            ruleId: cascade.ruleId,
            sourceDomain: cascade.source,
            severity: cascade.severity ?? 'low',
          });
        }
      }
    }

    // Sort by severity: critical first, then high, medium, low
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    actions.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

    return actions;
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
