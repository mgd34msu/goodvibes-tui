/**
 * State Inspector diagnostic panel data provider.
 *
 * Produces on-demand snapshots of the runtime store's domain states.
 * Implements the "Live domain state viewer" and "Raw state mode" from
 * Devtools / State Inspector.
 *
 * All domains are serialized to JSON-safe plain objects at snapshot time.
 * Maps and Sets are converted to arrays; circular references are replaced
 * with a sentinel string.
 */
import type { RuntimeStateSnapshot, DomainStateEntry } from '../types.ts';
import type { HotspotReport } from '../../ui/state-inspector/types.ts';
import { serializeSafe } from '../../ui/state-inspector/serialize.ts';

/**
 * Minimal interface for a domain state slice used by the inspector.
 * Each domain registered with the store should conform to this shape.
 */
export interface InspectableDomain {
  /** Domain name identifier. */
  readonly name: string;
  /** Retrieve the current domain state as a plain object. */
  getState(): Record<string, unknown>;
  /** The revision counter from the domain state. */
  getRevision(): number;
  /** The lastUpdatedAt timestamp from the domain state. */
  getLastUpdatedAt(): number;
}

/**
 * Hotspot analysis summary for display in the diagnostics panel.
 * Provides a read-only view of the current selector hotspot report.
 */
export interface HotspotAnalysisView {
  /** The full hotspot report, or undefined when no sampler is attached. */
  readonly report: HotspotReport | undefined;
  /** Top churn hotspots (highest calls/sec) — up to 5. */
  readonly topChurn: HotspotReport['hotspots'];
  /** Top latency hotspots (highest p95) — up to 5. */
  readonly topLatency: HotspotReport['hotspots'];
  /** Whether any churn hotspots are above threshold. */
  readonly hasChurnHotspots: boolean;
  /** Whether any latency hotspots are above threshold. */
  readonly hasLatencyHotspots: boolean;
}

/**
 * Callback type for providing an on-demand hotspot report.
 * Decouples the diagnostics panel from the sampler implementation.
 */
export type HotspotReportProvider = () => HotspotReport | undefined;

/**
 * StateInspectorPanel — on-demand runtime state snapshot provider.
 *
 * Domains are registered at construction time. Call `getSnapshot()` to
 * capture the current state of all registered domains.
 *
 * Optionally accepts a `HotspotReportProvider` callback to surface
 * selector hotspot analysis. Call `getHotspotAnalysis()` to retrieve
 * the current view.
 *
 * Unlike event-driven panels, this panel does not maintain an internal
 * buffer — each `getSnapshot()` call produces a fresh snapshot.
 */
export class StateInspectorPanel {
  private readonly _domains: InspectableDomain[];
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Optional hotspot report provider. */
  private _hotspotProvider: HotspotReportProvider | undefined;

  /**
   * @param domains - Array of domain adapters to inspect.
   * @param hotspotProvider - Optional provider for selector hotspot reports.
   */
  constructor(domains: InspectableDomain[] = [], hotspotProvider?: HotspotReportProvider) {
    this._domains = domains;
    this._hotspotProvider = hotspotProvider;
  }

  /**
   * Register an additional domain for inspection after construction.
   *
   * @param domain - Domain adapter to add.
   */
  public registerDomain(domain: InspectableDomain): void {
    this._domains.push(domain);
    this._notify();
  }

  /**
   * Capture a point-in-time snapshot of all registered domains.
   * Maps and Sets in the state are converted to plain objects/arrays.
   *
   * @returns An immutable RuntimeStateSnapshot.
   */
  public getSnapshot(): RuntimeStateSnapshot {
    const entries: DomainStateEntry[] = this._domains.map((domain) => ({
      domain: domain.name,
      revision: domain.getRevision(),
      lastUpdatedAt: domain.getLastUpdatedAt(),
      state: serializeSafe(domain.getState()) as Record<string, unknown>,
    }));

    return {
      capturedAt: Date.now(),
      domains: entries,
    };
  }

  /**
   * Attach or replace the hotspot report provider.
   *
   * @param provider - Callback returning the current HotspotReport.
   */
  public setHotspotProvider(provider: HotspotReportProvider): void {
    this._hotspotProvider = provider;
  }

  /**
   * Return a structured hotspot analysis view for the diagnostics UI.
   *
   * Produces top-5 churn hotspots (by calls/sec) and top-5 latency
   * hotspots (by p95) from the current report. Returns an empty view
   * when no hotspot provider is attached.
   *
   * @returns HotspotAnalysisView.
   */
  public getHotspotAnalysis(): HotspotAnalysisView {
    const report = this._hotspotProvider?.();

    if (!report) {
      return {
        report: undefined,
        topChurn: [],
        topLatency: [],
        hasChurnHotspots: false,
        hasLatencyHotspots: false,
      };
    }

    const { hotspots } = report;

    // Top churn: highest callsPerSecond
    const topChurn = [...hotspots]
      .sort((a, b) => b.callsPerSecond - a.callsPerSecond)
      .slice(0, 5);

    // Top latency: highest p95
    const topLatency = [...hotspots]
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 5);

    return {
      report,
      topChurn,
      topLatency,
      hasChurnHotspots: hotspots.some((h) => h.isChurnHotspot),
      hasLatencyHotspots: hotspots.some((h) => h.isLatencyHotspot),
    };
  }

  /**
   * Register a callback invoked when the domain registry changes.
   * Note: callbacks are NOT invoked on every state mutation — call
   * `getSnapshot()` on demand to retrieve current state.
   *
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
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
