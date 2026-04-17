import type { Line } from '../types/grid.ts';
import type { Panel, PanelCategory } from './types.ts';
import type { ComponentResourceContract, ComponentHealthState } from '../runtime/perf/panel-contracts.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { SPINNER_FRAMES } from '../renderer/progress.ts';

export abstract class BasePanel implements Panel {
  public needsRender = true;
  public isTransient = false;
  public isPinned = false;
  protected readonly componentHealthMonitor?: ComponentHealthMonitor;

  // -------------------------------------------------------------------------
  // I2: Error surface slot
  // -------------------------------------------------------------------------

  /**
   * Last error message to surface in the panel footer.
   * Auto-cleared on the next keystroke by `ScrollableListPanel.handleInput()` (and any
   * subclass that calls `super.handleInput()` or manually calls `this.clearError()` at
   * the start of its handler). BasePanel itself does NOT auto-clear — only subclasses
   * that opt into the contract do.
   */
  protected lastError: string | null = null;

  /**
   * Set a transient error message. Triggers a re-render.
   * The error will be auto-cleared on the next keystroke if the panel extends
   * `ScrollableListPanel` (which calls `clearError()` at the top of `handleInput()`).
   */
  protected setError(msg: string): void {
    this.lastError = msg;
    this.needsRender = true;
  }

  /** Clear the current error. */
  protected clearError(): void {
    this.lastError = null;
  }

  /**
   * Build a single error Line for display above the hints footer.
   * Returns null when there is no active error.
   *
   * Color: bold red foreground (palette-consistent: #ef4444).
   */
  protected renderErrorLine(width: number): Line | null {
    if (!this.lastError) return null;
    return UIFactory.stringToLine(
      ` ✕ ${this.lastError}`.padEnd(width).slice(0, width),
      width,
      { fg: '#ef4444', bold: true },
    );
  }

  // -------------------------------------------------------------------------
  // I3: Loading spinner slot
  // -------------------------------------------------------------------------

  /** Tracks the loading label for the spinner (undefined = no spinner active). */
  protected loadingState: 'idle' | 'loading' | 'error' = 'idle';
  private _loadingLabel = '';

  /** Begin loading. Triggers a re-render. */
  protected startLoading(label = 'Loading...'): void {
    this.loadingState = 'loading';
    this._loadingLabel = label;
    this.needsRender = true;
  }

  /** End loading (returns to idle). Triggers a re-render. */
  protected stopLoading(): void {
    this.loadingState = 'idle';
    this._loadingLabel = '';
    this.needsRender = true;
  }

  /**
   * Run an async operation with the panel's loading spinner visible.
   * The spinner is always cleared on completion, whether the operation succeeds or throws
   * (uses try/finally). Rethrows any error so callers can handle it or forward to setError.
   *
   * @param label Optional label shown next to the spinner.
   * @param fn    The async work to run.
   *
   * @example
   * ```ts
   * try {
   *   await this.withLoading('Loading diff…', () => this.fetchDiff());
   * } catch (err) {
   *   this.setError(summarizeError(err));
   * }
   * ```
   */
  protected async withLoading<T>(label: string | undefined, fn: () => Promise<T>): Promise<T> {
    this.startLoading(label);
    try {
      return await fn();
    } finally {
      this.stopLoading();
    }
  }

  /**
   * Build a spinner Line for the loading state.
   * Returns null when loadingState is not 'loading'.
   *
   * @param width  Panel width in columns.
   * @param frame  Current animation frame index (caller increments each render).
   */
  protected renderLoadingLine(width: number, frame = 0): Line | null {
    if (this.loadingState !== 'loading') return null;
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!;
    const text = ` ${spinner} ${this._loadingLabel}`;
    return UIFactory.stringToLine(text.padEnd(width).slice(0, width), width, { fg: '135', bold: true });
  }

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

  /** Cache of the most recent lines produced by trackedRender. */
  private _lastTrackedLines: Line[] = [];

  /**
   * Wrap a render body with canRenderNow throttle check, wall-clock timing,
   * and automatic reportRenderDuration.
   *
   * When throttled, returns the previously cached lines (stale but correctly
   * sized) rather than empty lines, avoiding a flicker on every skipped frame.
   *
   * Usage:
   * ```ts
   * render(width: number, height: number): Line[] {
   *   return this.trackedRender(() => {
   *     // expensive render logic
   *     return lines;
   *   });
   * }
   * ```
   */
  protected trackedRender(fn: () => Line[]): Line[] {
    if (!this.canRenderNow()) return this._lastTrackedLines;
    const start = Date.now();
    const lines = fn();
    this.reportRenderDuration(Date.now() - start);
    this._lastTrackedLines = lines;
    return lines;
  }
}
