/**
 * ForensicsRegistry — in-memory store for FailureReport objects.
 *
 * Maintains a bounded circular buffer of reports (newest last), keyed by
 * report ID for O(1) lookup. Supports `latest()`, `getById()`, and
 * `exportAsJson()` for the /forensics command subcommands.
 */
import type { FailureReport } from './types.ts';

/** Default maximum number of failure reports retained in memory. */
export const DEFAULT_REGISTRY_LIMIT = 100;

export class ForensicsRegistry {
  private readonly _reports: FailureReport[] = [];
  private readonly _byId = new Map<string, FailureReport>();
  private readonly _limit: number;
  private readonly _subscribers = new Set<() => void>();

  public constructor(limit: number = DEFAULT_REGISTRY_LIMIT) {
    this._limit = limit;
  }

  /**
   * Push a new failure report into the registry.
   * If the buffer is full, the oldest entry is evicted.
   */
  public push(report: FailureReport): void {
    // Evict oldest if at capacity
    if (this._reports.length >= this._limit) {
      const evicted = this._reports.shift();
      if (evicted) this._byId.delete(evicted.id);
    }
    this._reports.push(report);
    this._byId.set(report.id, report);
    this._notify();
  }

  /**
   * Return the most recently generated report, or undefined if none exist.
   */
  public latest(): FailureReport | undefined {
    return this._reports.at(-1);
  }

  /**
   * Return a report by its short ID, or undefined if not found.
   */
  public getById(id: string): FailureReport | undefined {
    return this._byId.get(id);
  }

  /**
   * Return all reports, newest first.
   */
  public getAll(): FailureReport[] {
    return [...this._reports].reverse();
  }

  /**
   * Return the count of retained reports.
   */
  public count(): number {
    return this._reports.length;
  }

  /**
   * Serialize a report to a pretty-printed JSON string.
   * Returns undefined if the report ID is not found.
   */
  public exportAsJson(id: string): string | undefined {
    const report = this._byId.get(id);
    if (!report) return undefined;
    return JSON.stringify(report, null, 2);
  }

  /**
   * Subscribe to registry changes. Returns an unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => { this._subscribers.delete(callback); };
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try { cb(); } catch { /* non-fatal — subscriber errors must not affect the registry */ }
    }
  }
}
