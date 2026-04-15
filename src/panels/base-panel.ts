import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { Panel, PanelCategory } from './types.ts';
import type { PanelResourceContract, PanelHealthState } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-contracts';
import type { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-health-monitor';

export abstract class BasePanel implements Panel {
  public needsRender = true;
  public isTransient = false;
  public isPinned = false;
  protected readonly panelHealthMonitor?: PanelHealthMonitor;

  /**
   * Optional resource contract for this panel.
   * Override in subclasses to declare a custom contract; leave undefined
   * to use the category default enforced by PanelHealthMonitor.
   */
  public resourceContract: Readonly<PanelResourceContract> | undefined = undefined;

  /**
   * Live health state populated by PanelHealthMonitor.
   * Read-only from outside the monitor.
   */
  public get healthState(): Readonly<PanelHealthState> | undefined {
    return this.panelHealthMonitor?.getHealth(this.id);
  }

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly icon: string,
    public readonly category: PanelCategory,
    panelHealthMonitor?: PanelHealthMonitor,
  ) {
    this.panelHealthMonitor = panelHealthMonitor;
  }

  onActivate(): void { this.needsRender = true; }
  onDeactivate(): void {}
  onDestroy(): void {}

  abstract render(width: number, height: number): Line[];

  protected markDirty(): void { this.needsRender = true; }

  /**
   * Check whether the panel is currently permitted to render.
   *
   * Consults the shared PanelHealthMonitor. Returns true if not registered
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
    return this.panelHealthMonitor?.canRender(this.id, now) ?? true;
  }

  /**
   * Report the duration of a completed render to the health monitor.
   * Call this at the end of render() after measuring wall-clock cost.
   */
  protected reportRenderDuration(durationMs: number, now: number = Date.now()): void {
    this.panelHealthMonitor?.recordRender(this.id, durationMs, now);
  }
}
