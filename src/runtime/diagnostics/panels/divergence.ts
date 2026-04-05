/**
 * Divergence diagnostics panel data provider.
 *
 * Wraps a `DivergenceDashboard` and exposes its state for the diagnostics
 * view as a snapshot-based panel. Subscribers are notified whenever a new
 * trend entry is recorded.
 *
 * This panel is push-passive: it does not drive the sampling timer itself.
 * The caller (or a coordinator) must call `recordTrendEntry()` periodically.
 */

import type { DivergenceDashboardSnapshot, EnforceGateResult } from '../../permissions/divergence-dashboard.ts';
import { DivergenceDashboard } from '../../permissions/divergence-dashboard.ts';
import type { PanelConfig } from '../types.ts';
import { DEFAULT_PANEL_CONFIG } from '../types.ts';

/**
 * DivergencePanel — diagnostics data provider for the divergence dashboard.
 *
 * Usage:
 * ```ts
 * const panel = new DivergencePanel(dashboard);
 * panel.subscribe(() => {
 *   const snap = panel.getSnapshot();
 *   render(snap);
 * });
 *
 * // Drive sampling externally:
 * setInterval(() => panel.recordTrendEntry(), 30_000);
 *
 * // On cleanup:
 * panel.dispose();
 * ```
 */
export class DivergencePanel {
  private readonly _dashboard: DivergenceDashboard;
  private readonly _config: PanelConfig;
  private readonly _subscribers = new Set<() => void>();

  constructor(
    dashboard: DivergenceDashboard,
    config: PanelConfig = DEFAULT_PANEL_CONFIG,
  ) {
    this._dashboard = dashboard;
    this._config = config;
  }

  /**
   * recordTrendEntry — Captures a trend snapshot and notifies subscribers.
   *
   * Call this on a periodic timer (e.g. every 30 seconds) to build trend
   * history. The panel respects `bufferLimit` for display purposes; the
   * dashboard's own ring buffer governs actual retention.
   */
  public recordTrendEntry(): void {
    this._dashboard.recordTrendEntry();
    this._notify();
  }

  /**
   * getSnapshot — Returns the current full dashboard snapshot.
   *
   * The trend is capped at `bufferLimit` entries for display.
   */
  public getSnapshot(): DivergenceDashboardSnapshot {
    const raw = this._dashboard.getSnapshot();
    // Apply display-level buffer cap to trend history.
    const limit = this._config.bufferLimit;
    const trend = raw.trend.length > limit ? raw.trend.slice(-limit) : raw.trend;
    return { ...raw, trend };
  }

  /**
   * checkEnforceGate — Delegates to the underlying dashboard's gate check.
   */
  public checkEnforceGate(): EnforceGateResult {
    return this._dashboard.checkEnforceGate();
  }

  /**
   * Register a callback invoked whenever a trend entry is recorded.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all subscriptions.
   */
  public dispose(): void {
    this._subscribers.clear();
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the panel
        console.debug('[DivergencePanel] subscriber error:', err);
      }
    }
  }
}
