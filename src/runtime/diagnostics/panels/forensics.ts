/**
 * ForensicsDataPanel — diagnostic data provider for the Forensics panel.
 *
 * Bridges the ForensicsRegistry into the panel subscription model,
 * following the same pattern as OpsPanel and TasksPanel.
 */
import type { PanelConfig } from '../types.ts';
import { DEFAULT_PANEL_CONFIG } from '../types.ts';
import type { FailureReport } from '../../forensics/types.ts';
import type { ForensicsRegistry } from '../../forensics/registry.ts';

export class ForensicsDataPanel {
  private readonly _config: PanelConfig;
  private readonly _registry: ForensicsRegistry;
  private readonly _subscribers = new Set<() => void>();
  private _unsub: (() => void) | null = null;

  public constructor(
    registry: ForensicsRegistry,
    config: PanelConfig = DEFAULT_PANEL_CONFIG,
  ) {
    this._config = config;
    this._registry = registry;
    this._unsub = registry.subscribe(() => this._notify());
  }

  /**
   * Return all reports, newest first, capped at bufferLimit.
   */
  public getAll(): FailureReport[] {
    const all = this._registry.getAll();
    return all.slice(0, this._config.bufferLimit);
  }

  /**
   * Return the most recent report.
   */
  public latest(): FailureReport | undefined {
    return this._registry.latest();
  }

  /**
   * Return a report by ID.
   */
  public getById(id: string): FailureReport | undefined {
    return this._registry.getById(id);
  }

  /**
   * Subscribe to data changes. Returns an unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => { this._subscribers.delete(callback); };
  }

  /**
   * Dispose the data panel, unsubscribing from the registry.
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
      try { cb(); } catch { /* non-fatal */ }
    }
  }
}
