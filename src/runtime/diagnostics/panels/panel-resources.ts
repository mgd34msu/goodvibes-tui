/**
 * Panel resource diagnostics panel data provider.
 *
 * Polls the shared PanelHealthMonitor and produces PanelResourceSnapshot
 * values for the panel resource diagnostics view.
 *
 * Subscribers are notified on each poll cycle. The poll interval is
 * configurable; callers can also request an immediate snapshot via
 * getSnapshot().
 */
import type { PanelHealthMonitor } from '../../perf/panel-health-monitor.ts';
import type { PanelResourceEntry, PanelResourceSnapshot } from '../types.ts';

/** Default poll interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Severity order for sorting: overloaded > warning > healthy. */
const HEALTH_ORDER: Record<string, number> = {
  overloaded: 0,
  warning: 1,
  healthy: 2,
};

/**
 * PanelResourcesPanel — diagnostic data provider for panel resource health.
 *
 * Polls the PanelHealthMonitor on a configurable interval and maintains a
 * current PanelResourceSnapshot for the diagnostics panel to render.
 */
export class PanelResourcesPanel {
  private readonly _pollIntervalMs: number;
  private readonly _monitor: PanelHealthMonitor;
  private _current: PanelResourceSnapshot;
  private _timerId: ReturnType<typeof setInterval> | null = null;
  private readonly _subscribers = new Set<() => void>();

  constructor(monitor: PanelHealthMonitor, pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
    this._monitor = monitor;
    this._pollIntervalMs = pollIntervalMs;
    this._current = this._buildSnapshot(Date.now());
  }

  /**
   * Start polling the health monitor.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this._timerId !== null) return;
    this._timerId = setInterval(() => {
      this._current = this._buildSnapshot(Date.now());
      this._notify();
    }, this._pollIntervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Return the most recent panel resource snapshot.
   */
  getSnapshot(): PanelResourceSnapshot {
    return this._current;
  }

  /**
   * Force an immediate snapshot refresh and return it.
   */
  refresh(now: number = Date.now()): PanelResourceSnapshot {
    this._current = this._buildSnapshot(now);
    return this._current;
  }

  /**
   * Register a callback invoked whenever the snapshot is refreshed.
   * @returns An unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Stop polling and clear all subscribers.
   */
  dispose(): void {
    this.stop();
    this._subscribers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _buildSnapshot(capturedAt: number): PanelResourceSnapshot {
    const healthStates = this._monitor.getAllHealth();

    const panels: PanelResourceEntry[] = healthStates.map((h) => {
      const contract = this._monitor.getContract(h.panelId);
      return {
        panelId: h.panelId,
        throttleStatus: h.throttleStatus,
        healthStatus: h.healthStatus,
        renderP95Ms: h.renderP95Ms,
        maxRenderMs: contract?.maxRenderMs ?? 0,
        rendersInWindow: h.rendersInWindow,
        maxUpdatesPerSecond: contract?.maxUpdatesPerSecond ?? 0,
        consecutiveViolations: h.consecutiveViolations,
        totalSuppressed: h.totalSuppressed,
        totalPermitted: h.totalPermitted,
        lastRenderAt: h.lastRenderAt,
        nextAllowedAt: h.nextAllowedAt,
      };
    });

    // Sort: overloaded first, then warning, then healthy; alphabetical within tier
    panels.sort((a, b) => {
      const diff = (HEALTH_ORDER[a.healthStatus] ?? 2) - (HEALTH_ORDER[b.healthStatus] ?? 2);
      return diff !== 0 ? diff : a.panelId.localeCompare(b.panelId);
    });

    const overloadedCount = panels.filter((p) => p.healthStatus === 'overloaded').length;
    const warningCount = panels.filter((p) => p.healthStatus === 'warning').length;
    const healthyCount = panels.filter((p) => p.healthStatus === 'healthy').length;
    const totalSuppressed = panels.reduce((sum, p) => sum + p.totalSuppressed, 0);

    return {
      panels,
      overloadedCount,
      warningCount,
      healthyCount,
      totalSuppressed,
      capturedAt,
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
