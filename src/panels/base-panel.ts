import type { Line } from '../types/grid.ts';
import type { Panel, PanelCategory } from './types.ts';
import type { ComponentResourceContract, ComponentHealthState } from '../runtime/perf/panel-contracts.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';

export abstract class BasePanel implements Panel {
  public needsRender = true;
  public isTransient = false;
  public isPinned = false;
  protected readonly componentHealthMonitor?: ComponentHealthMonitor;

  /**
   * Optional resource contract for this panel.
   * Override in subclasses to declare a custom contract; leave undefined
   * to use the category default enforced by ComponentHealthMonitor.
   */
  public resourceContract: Readonly<ComponentResourceContract> | undefined = undefined;

  /**
   * Live health state populated by ComponentHealthMonitor.
   * Read-only from outside the monitor.
   */
  public get healthState(): Readonly<ComponentHealthState> | undefined {
    return this.componentHealthMonitor?.getHealth(this.id);
  }

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly icon: string,
    public readonly category: PanelCategory,
    componentHealthMonitor?: ComponentHealthMonitor,
  ) {
    this.componentHealthMonitor = componentHealthMonitor;
  }

  onActivate(): void { this.needsRender = true; }
  onDeactivate(): void {}
  onDestroy(): void {}

  abstract render(width: number, height: number): Line[];

  /** R2: Mark this panel dirty — it will be re-rendered on the next compositor frame. */
  public invalidate(): void { this.needsRender = true; }

  /** R2: Called by the compositor after a successful render to clear the dirty flag. */
  public markRendered(): void { this.needsRender = false; }

  protected markDirty(): void { this.needsRender = true; }

  /**
   * Check whether the panel is currently permitted to render.
   *
   * Consults the shared ComponentHealthMonitor. Returns true if not registered
   * (unthrottled) or if the monitor permits a render at this moment.
   *
   * Call this inside render() or before invoking render() to skip
   * expensive work when throttled:
   *
   * ```ts
   * render(width, height): Line[] {
   *   if (!this.canRenderNow()) return this._lastLines ?? [];
   *   // ... expensive render ...
   * }
   * ```
   */
  protected canRenderNow(now: number = Date.now()): boolean {
    return this.componentHealthMonitor?.canRender(this.id, now) ?? true;
  }

  /**
   * Report the duration of a completed render to the health monitor.
   * Call this at the end of render() after measuring wall-clock cost.
   */
  protected reportRenderDuration(durationMs: number, now: number = Date.now()): void {
    this.componentHealthMonitor?.recordRender(this.id, durationMs, now);
  }
}
