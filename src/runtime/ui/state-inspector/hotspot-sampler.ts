/**
 * Selector hotspot sampler for the state inspector.
 *
 * Tracks invocation frequency and execution duration for named selectors.
 * An operator can inspect which selectors fire most often (churn hotspots)
 * or take the longest (latency hotspots) to isolate render/subscription
 * performance problems.
 *
 * ### Usage
 * ```ts
 * const sampler = new SelectorHotspotSampler({ windowMs: 10_000 });
 *
 * // Instrument a selector call site:
 * const t0 = performance.now();
 * const result = selectRunningTasks(state);
 * sampler.record('selectRunningTasks', performance.now() - t0);
 *
 * const report = sampler.getReport();
 * ```
 *
 * The sampler uses a sliding-window of raw samples to compute p50/p95/p99
 * latencies and a calls-per-second rate. Samples older than `windowMs`
 * are dropped on each `record()` call (lazy GC).
 */
import type { SelectorHotspot, HotspotReport, HotspotSamplerConfig } from './types.ts';
import { DEFAULT_HOTSPOT_WINDOW_MS, DEFAULT_HOTSPOT_MAX_SAMPLES_PER_KEY } from './types.ts';

/** Raw per-call sample retained in the sliding window. */
interface RawSample {
  readonly ts: number;     // epoch ms at record time
  readonly durationMs: number;
}

/** Per-selector state. */
interface SelectorState {
  readonly key: string;
  samples: RawSample[];    // sliding window, oldest first
  totalCalls: number;      // lifetime total (not windowed)
  totalDurationMs: number; // lifetime total
}

/**
 * SelectorHotspotSampler — sliding-window latency + frequency tracker.
 *
 * Thread-safety note: synchronous JS — no concurrency concerns.
 */
export class SelectorHotspotSampler {
  private readonly _windowMs: number;
  private readonly _maxSamplesPerKey: number;
  private readonly _selectors = new Map<string, SelectorState>();

  /**
   * @param config — Optional sampler configuration.
   */
  constructor(config: HotspotSamplerConfig = {}) {
    this._windowMs = config.windowMs ?? DEFAULT_HOTSPOT_WINDOW_MS;
    this._maxSamplesPerKey = config.maxSamplesPerKey ?? DEFAULT_HOTSPOT_MAX_SAMPLES_PER_KEY;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Current sliding window duration in ms. */
  get windowMs(): number {
    return this._windowMs;
  }

  /**
   * Record a selector invocation.
   *
   * @param key — Selector name / identifier.
   * @param durationMs — Execution time in milliseconds (may be 0 for sync).
   */
  public record(key: string, durationMs: number): void {
    const now = Date.now();

    let state = this._selectors.get(key);
    if (!state) {
      state = { key, samples: [], totalCalls: 0, totalDurationMs: 0 };
      this._selectors.set(key, state);
    }

    // Lazy GC: drop samples outside the window
    this._evictOldSamples(state, now);

    // Enforce per-key sample cap (drop oldest when over limit)
    if (state.samples.length >= this._maxSamplesPerKey) {
      state.samples.shift();
    }

    state.samples.push({ ts: now, durationMs });
    state.totalCalls++;
    state.totalDurationMs += durationMs;
  }

  /**
   * Return a sorted hotspot report.
   *
   * Hotspots are sorted by `callsInWindow` descending (churn first),
   * then by `p95Ms` descending as a tiebreaker.
   *
   * @returns HotspotReport.
   */
  public getReport(): HotspotReport {
    const now = Date.now();
    const hotspots: SelectorHotspot[] = [];

    for (const state of this._selectors.values()) {
      this._evictOldSamples(state, now);
      hotspots.push(this._computeHotspot(state, now));
    }

    hotspots.sort((a, b) =>
      b.callsInWindow - a.callsInWindow || b.p95Ms - a.p95Ms
    );

    return {
      generatedAt: now,
      windowMs: this._windowMs,
      hotspots,
    };
  }

  /**
   * Return the hotspot for a single selector key, or undefined if never recorded.
   *
   * @param key — Selector identifier.
   */
  public getHotspot(key: string): SelectorHotspot | undefined {
    const state = this._selectors.get(key);
    if (!state) return undefined;
    const now = Date.now();
    this._evictOldSamples(state, now);
    return this._computeHotspot(state, now);
  }

  /**
   * Return the top N selectors by call count in the current window.
   *
   * @param n — Maximum number of hotspots to return.
   */
  public getTopHotspots(n: number): SelectorHotspot[] {
    return this.getReport().hotspots.slice(0, n);
  }

  /** Number of distinct selector keys tracked. */
  get trackedKeyCount(): number {
    return this._selectors.size;
  }

  /**
   * Clear all recorded samples and reset tracking.
   * Does not reset configuration.
   */
  public reset(): void {
    this._selectors.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _evictOldSamples(state: SelectorState, now: number): void {
    const cutoff = now - this._windowMs;
    // Samples are chronological oldest-first; trim from front
    let i = 0;
    while (i < state.samples.length && state.samples[i].ts < cutoff) {
      i++;
    }
    if (i > 0) {
      state.samples = state.samples.slice(i);
    }
  }

  private _computeHotspot(state: SelectorState, now: number): SelectorHotspot {
    const windowSec = this._windowMs / 1_000;
    const samples = state.samples;
    const callsInWindow = samples.length;

    // Calls-per-second in window
    const callsPerSecond = windowSec > 0 ? callsInWindow / windowSec : 0;

    // Compute latency percentiles from windowed samples
    const { p50, p95, p99, avgMs, maxMs } = this._percentiles(samples);

    return {
      key: state.key,
      callsInWindow,
      callsPerSecond: Math.round(callsPerSecond * 100) / 100,
      totalCalls: state.totalCalls,
      avgMs,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      maxMs,
      isChurnHotspot: callsPerSecond > 10,   // >10 calls/sec
      isLatencyHotspot: p95 > 5,              // p95 > 5ms
    };
  }

  private _percentiles(samples: RawSample[]): {
    p50: number; p95: number; p99: number; avgMs: number; maxMs: number;
  } {
    if (samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0, avgMs: 0, maxMs: 0 };
    }

    const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
    const len = durations.length;
    const sum = durations.reduce((acc, v) => acc + v, 0);

    const pAt = (pct: number): number => {
      const idx = Math.min(Math.ceil(len * pct) - 1, len - 1);
      return Math.round((durations[Math.max(idx, 0)] ?? 0) * 100) / 100;
    };

    return {
      p50: pAt(0.5),
      p95: pAt(0.95),
      p99: pAt(0.99),
      avgMs: Math.round((sum / len) * 100) / 100,
      maxMs: Math.round((durations[len - 1] ?? 0) * 100) / 100,
    };
  }
}
