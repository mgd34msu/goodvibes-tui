/**
 * Panel resource diagnostics panel data provider.
 *
 * Polls the shared TUI-owned ComponentHealthMonitor and produces PanelResourceSnapshot
 * values for the diagnostics panel to render.
 */
import type { ComponentHealthMonitor } from '../../perf/panel-health-monitor.ts';
import type {
  ComponentResourceEntry,
  ComponentResourceSnapshot,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';

const DEFAULT_POLL_INTERVAL_MS = 500;

const HEALTH_ORDER: Record<string, number> = {
  overloaded: 0,
  warning: 1,
  healthy: 2,
};

export class PanelResourcesPanel {
  private readonly _pollIntervalMs: number;
  private readonly _monitor: ComponentHealthMonitor;
  private _current: ComponentResourceSnapshot;
  private _timerId: ReturnType<typeof setInterval> | null = null;
  private readonly _subscribers = new Set<() => void>();

  constructor(monitor: ComponentHealthMonitor, pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
    this._monitor = monitor;
    this._pollIntervalMs = pollIntervalMs;
    this._current = this._buildSnapshot(Date.now());
  }

  start(): void {
    if (this._timerId !== null) return;
    this._timerId = setInterval(() => {
      this._current = this._buildSnapshot(Date.now());
      this._notify();
    }, this._pollIntervalMs);
  }

  stop(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  getSnapshot(): ComponentResourceSnapshot {
    return this._current;
  }

  refresh(now: number = Date.now()): ComponentResourceSnapshot {
    this._current = this._buildSnapshot(now);
    return this._current;
  }

  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  dispose(): void {
    this.stop();
    this._subscribers.clear();
  }

  private _buildSnapshot(capturedAt: number): ComponentResourceSnapshot {
    const healthStates = this._monitor.getAllHealth();

    const panels: ComponentResourceEntry[] = healthStates.map((health) => {
      const contract = this._monitor.getContract(health.componentId);
      return {
        componentId: health.componentId,
        throttleStatus: health.throttleStatus,
        healthStatus: health.healthStatus,
        renderP95Ms: health.renderP95Ms,
        maxRenderMs: contract?.maxRenderMs ?? 0,
        rendersInWindow: health.rendersInWindow,
        maxUpdatesPerSecond: contract?.maxUpdatesPerSecond ?? 0,
        consecutiveViolations: health.consecutiveViolations,
        totalSuppressed: health.totalSuppressed,
        totalPermitted: health.totalPermitted,
        lastRenderAt: health.lastRenderAt,
        nextAllowedAt: health.nextAllowedAt,
      };
    });

    panels.sort((left, right) => {
      const diff = (HEALTH_ORDER[left.healthStatus] ?? 2) - (HEALTH_ORDER[right.healthStatus] ?? 2);
      return diff !== 0 ? diff : left.componentId.localeCompare(right.componentId);
    });

    const overloadedCount = panels.filter((panel) => panel.healthStatus === 'overloaded').length;
    const warningCount = panels.filter((panel) => panel.healthStatus === 'warning').length;
    const healthyCount = panels.filter((panel) => panel.healthStatus === 'healthy').length;
    const totalSuppressed = panels.reduce((sum, panel) => sum + panel.totalSuppressed, 0);

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
    for (const callback of this._subscribers) {
      try {
        callback();
      } catch {
        // Subscriber failures must not take down diagnostics polling.
      }
    }
  }
}
