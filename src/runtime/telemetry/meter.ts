/**
 * RuntimeMeter — lightweight OTel-compatible metric instruments.
 *
 * Provides Counter, Histogram, and Gauge instruments without depending
 * on the @opentelemetry/* packages.
 *
 * All operations are synchronous and allocation-light. Label sets are
 * serialised to a stable string key for Map lookups.
 */
import type {
  Counter,
  Gauge,
  Histogram,
  HistogramSnapshot,
  MeterConfig,
  MetricLabels,
} from './types.ts';

// ── Label key serialisation ─────────────────────────────────────────────────────

/**
 * Serialise a label set to a stable, deterministic string key.
 * Sorts keys to ensure `{a:1,b:2}` and `{b:2,a:1}` produce the same key.
 */
function labelKey(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return '__default__';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

// ── CounterImpl ──────────────────────────────────────────────────────────────────

class CounterImpl implements Counter {
  private readonly _values = new Map<string, number>();

  add(delta = 1, labels?: MetricLabels): void {
    if (delta < 0) return; // Counters are monotonically increasing
    const key = labelKey(labels);
    this._values.set(key, (this._values.get(key) ?? 0) + delta);
  }

  value(labels?: MetricLabels): number {
    return this._values.get(labelKey(labels)) ?? 0;
  }
}

// ── HistogramImpl ─────────────────────────────────────────────────────────────

interface HistogramAccumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
}

class HistogramImpl implements Histogram {
  private readonly _accumulators = new Map<string, HistogramAccumulator>();

  record(value: number, labels?: MetricLabels): void {
    const key = labelKey(labels);
    const acc = this._accumulators.get(key);
    if (acc === undefined) {
      this._accumulators.set(key, { count: 1, sum: value, min: value, max: value });
    } else {
      acc.count += 1;
      acc.sum += value;
      if (value < acc.min) acc.min = value;
      if (value > acc.max) acc.max = value;
    }
  }

  snapshot(labels?: MetricLabels): HistogramSnapshot {
    const acc = this._accumulators.get(labelKey(labels));
    if (!acc) {
      return { count: 0, sum: 0, min: 0, max: 0, mean: 0 };
    }
    return {
      count: acc.count,
      sum: acc.sum,
      min: acc.min,
      max: acc.max,
      mean: acc.count > 0 ? acc.sum / acc.count : 0,
    };
  }
}

// ── GaugeImpl ───────────────────────────────────────────────────────────────────

class GaugeImpl implements Gauge {
  private readonly _values = new Map<string, number>();

  set(value: number, labels?: MetricLabels): void {
    this._values.set(labelKey(labels), value);
  }

  value(labels?: MetricLabels): number {
    return this._values.get(labelKey(labels)) ?? 0;
  }
}

// ── RuntimeMeter ────────────────────────────────────────────────────────────

/**
 * RuntimeMeter — creates and caches named metric instruments.
 *
 * Usage:
 * ```ts
 * const turns = meter.counter('turn.completed');
 * turns.add(1, { provider: 'anthropic' });
 *
 * const latency = meter.histogram('llm.latency.ms');
 * latency.record(342, { model: 'claude-3-5-sonnet' });
 *
 * const activeConns = meter.gauge('mcp.connections.active');
 * activeConns.set(3);
 * ```
 */
export class RuntimeMeter {
  private readonly config: MeterConfig;
  private readonly _counters = new Map<string, Counter>();
  private readonly _histograms = new Map<string, Histogram>();
  private readonly _gauges = new Map<string, Gauge>();

  constructor(config: MeterConfig) {
    this.config = config;
  }

  /** Return the meter's instrumentation scope name. */
  get scope(): string {
    return this.config.scope;
  }

  /**
   * Get or create a named counter (monotonically increasing).
   * Repeated calls with the same name return the same instrument.
   */
  counter(name: string): Counter {
    let c = this._counters.get(name);
    if (!c) {
      c = new CounterImpl();
      this._counters.set(name, c);
    }
    return c;
  }

  /**
   * Get or create a named histogram (distribution of values).
   * Repeated calls with the same name return the same instrument.
   */
  histogram(name: string): Histogram {
    let h = this._histograms.get(name);
    if (!h) {
      h = new HistogramImpl();
      this._histograms.set(name, h);
    }
    return h;
  }

  /**
   * Get or create a named gauge (point-in-time value).
   * Repeated calls with the same name return the same instrument.
   */
  gauge(name: string): Gauge {
    let g = this._gauges.get(name);
    if (!g) {
      g = new GaugeImpl();
      this._gauges.set(name, g);
    }
    return g;
  }
}
