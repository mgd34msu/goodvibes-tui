/**
 * Section 5.3 — Policy diagnostics panel data provider.
 *
 * Wraps a `PolicyRegistry` and optionally a `DivergencePanel` to expose
 * combined policy state (current bundle, candidate, simulation status,
 * divergence trends) for the diagnostics view.
 *
 * This panel is push-passive: it does not drive timers. Callers must
 * call `recordTrendEntry()` periodically if a divergence panel is attached.
 */

import type { PolicyBundleVersion, PolicyDiffResult } from '../../permissions/policy-registry.ts';
import { PolicyRegistry } from '../../permissions/policy-registry.ts';
import type { DivergenceDashboardSnapshot } from '../../permissions/divergence-dashboard.ts';
import type { DivergencePanel } from './divergence.ts';
import type { PanelConfig } from '../types.ts';
import { DEFAULT_PANEL_CONFIG } from '../types.ts';

/**
 * A point-in-time snapshot of policy state for diagnostics rendering.
 */
export interface PolicyPanelSnapshot {
  /** The currently enforced bundle, or null if no policy is active. */
  current: PolicyBundleVersion | null;
  /** The pending candidate bundle, or null if none loaded. */
  candidate: PolicyBundleVersion | null;
  /** History of previous active bundles (most recent first). */
  history: PolicyBundleVersion[];
  /** Diff between current and candidate, or null if unavailable. */
  diff: PolicyDiffResult | null;
  /** Divergence dashboard snapshot, or null if no panel attached. */
  divergence: DivergenceDashboardSnapshot | null;
  /** ISO 8601 timestamp of when this snapshot was captured. */
  capturedAt: string;
}

/**
 * PolicyPanel — diagnostics data provider for the policy registry.
 *
 * Usage:
 * ```ts
 * const registry = new PolicyRegistry();
 * const panel = new PolicyPanel(registry, divergencePanel);
 *
 * panel.subscribe(() => {
 *   const snap = panel.getSnapshot();
 *   render(snap);
 * });
 *
 * // Notify when the registry state changes:
 * panel.notify();
 *
 * // On cleanup:
 * panel.dispose();
 * ```
 */
export class PolicyPanel {
  private readonly _registry: PolicyRegistry;
  private readonly _divergencePanel: DivergencePanel | null;
  private readonly _config: PanelConfig;
  private readonly _subscribers = new Set<() => void>();

  constructor(
    registry: PolicyRegistry,
    divergencePanel: DivergencePanel | null = null,
    config: PanelConfig = DEFAULT_PANEL_CONFIG,
  ) {
    this._registry = registry;
    this._divergencePanel = divergencePanel;
    this._config = config;
  }

  /**
   * recordTrendEntry — Forwards to the attached DivergencePanel if present.
   *
   * Call periodically (e.g. every 30 seconds) while simulation is active.
   */
  public recordTrendEntry(): void {
    this._divergencePanel?.recordTrendEntry();
    this._notify();
  }

  /**
   * notify — Trigger a subscriber notification.
   *
   * Call after registry state changes (load, promote, rollback) so the
   * diagnostics view can re-render.
   */
  public notify(): void {
    this._notify();
  }

  /**
   * getSnapshot — Returns the current combined policy + divergence snapshot.
   */
  public getSnapshot(): PolicyPanelSnapshot {
    const current = this._registry.getCurrent();
    const candidate = this._registry.getCandidate();
    const rawHistory = this._registry.getHistory();
    // Most recent first, capped for display
    const history = rawHistory
      .slice()
      .reverse()
      .slice(0, this._config.bufferLimit);

    const diff = this._registry.diff();

    let divergence: DivergenceDashboardSnapshot | null = null;
    if (this._divergencePanel) {
      divergence = this._divergencePanel.getSnapshot();
    }

    return {
      current,
      candidate,
      history,
      diff,
      divergence,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Register a callback invoked whenever the panel state changes.
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
        console.debug('[PolicyPanel] subscriber error:', err);
      }
    }
  }
}
