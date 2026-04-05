/**
 * Replay panel data provider.
 *
 * Wraps a `DeterministicReplayEngine` and exposes its state for the
 * diagnostics view as a snapshot-based panel. Subscribers are notified
 * whenever the engine state changes (load, step, seek, diff, reset).
 *
 * This panel is push-passive: it does not drive the engine itself.
 * The caller (or the /replay command handler) drives the engine.
 */
import { logger } from '../../../utils/logger.ts';
import type {
  DeterministicReplayEngine,
  ReplayEngineSnapshot,
} from '../../../core/deterministic-replay.ts';

/**
 * ReplayPanel — diagnostics data provider for the deterministic replay view.
 *
 * Usage:
 * ```ts
 * const panel = new ReplayPanel(engine);
 * panel.subscribe(() => {
 *   const snap = panel.getSnapshot();
 *   render(snap);
 * });
 * ```
 */
export class ReplayPanel {
  private readonly _engine: DeterministicReplayEngine;
  private readonly _subscribers = new Set<() => void>();
  private _unsub: (() => void) | null = null;

  constructor(engine: DeterministicReplayEngine) {
    this._engine = engine;
    // Forward engine notifications to panel subscribers.
    this._unsub = engine.subscribe(() => this._notify());
  }

  /**
   * Get the current engine snapshot for rendering.
   */
  public getSnapshot(): ReplayEngineSnapshot {
    return this._engine.getSnapshot();
  }

  /**
   * Register a callback invoked whenever engine state changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all subscriptions and disconnect from the engine.
   */
  public dispose(): void {
    this._unsub?.();
    this._unsub = null;
    this._subscribers.clear();
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Non-fatal: subscriber errors must not crash the panel.
        logger.debug('[ReplayPanel] subscriber error', { err: String(err) });
      }
    }
  }
}
