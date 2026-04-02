/**
 * OTel-compatible type definitions for the lightweight RuntimeTelemetry layer.
 *
 * Designed to be structurally compatible with the OpenTelemetry API without
 * depending on the @opentelemetry/* packages. When the full SDK is introduced
 * in a later tier, these types can be aliased to the SDK equivalents.
 */

// ── Span types ───────────────────────────────────────────────────────────────

/** Span status codes — mirrors OTel StatusCode. */
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;
export type SpanStatusCode = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

/** Span kind — mirrors OTel SpanKind. */
export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

/** Attribute value types compatible with OTel AttributeValue. */
export type AttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

/** Key-value attribute bag. */
export type SpanAttributes = Record<string, AttributeValue>;

/** A timestamped annotation on a span (OTel SpanEvent). */
export interface SpanEvent {
  /** Event name. */
  readonly name: string;
  /** Epoch ms when the event occurred. */
  readonly timestamp: number;
  /** Optional attributes for this event. */
  readonly attributes?: SpanAttributes;
}

/** Immutable span context — the W3C TraceContext identifiers. */
export interface SpanContext {
  /** 128-bit trace ID as 32-char hex string. */
  readonly traceId: string;
  /** 64-bit span ID as 16-char hex string. */
  readonly spanId: string;
  /** Whether this context is valid (both IDs are non-zero). */
  readonly isValid: boolean;
}

/** Status of a span. */
export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly message?: string;
}

/** A completed, immutable span record ready for export. */
export interface ReadableSpan {
  /** Span name (e.g. 'turn.lifecycle', 'tool.execute'). */
  readonly name: string;
  /** Span kind. */
  readonly kind: SpanKind;
  /** This span's context. */
  readonly spanContext: SpanContext;
  /** Parent span ID (undefined for root spans). */
  readonly parentSpanId?: string;
  /** Epoch ms when the span started. */
  readonly startTimeMs: number;
  /** Epoch ms when the span ended. */
  readonly endTimeMs: number;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Key-value attributes. */
  readonly attributes: SpanAttributes;
  /** Timestamped events on this span. */
  readonly events: SpanEvent[];
  /** Final status. */
  readonly status: SpanStatus;
  /** Instrumentation scope name (e.g. 'goodvibes-tui/turn'). */
  readonly instrumentationScope: string;
}

/** A mutable span under construction. */
export interface Span {
  /** Span context (traceId + spanId). */
  readonly spanContext: SpanContext;
  /** Parent span ID, if this is a child span. */
  readonly parentSpanId?: string;
  /** Whether the span has ended. */
  readonly ended: boolean;

  /** Set a single attribute. */
  setAttribute(key: string, value: AttributeValue): this;
  /** Set multiple attributes at once. */
  setAttributes(attrs: SpanAttributes): this;
  /** Add a timestamped event. */
  addEvent(name: string, attributes?: SpanAttributes): this;
  /** Set the final status. */
  setStatus(status: SpanStatus): this;
  /** Record an exception (shorthand for addEvent + setStatus ERROR). */
  recordException(error: Error): this;
  /**
   * End the span, recording endTimeMs and durationMs.
   * After calling end(), setAttribute/addEvent are no-ops.
   */
  end(endTimeMs?: number): void;
  /** Return the immutable snapshot for export. */
  toReadable(): ReadableSpan;
}

// ── Meter / Metric types ─────────────────────────────────────────────────────

/** Label set for a metric observation. */
export type MetricLabels = Record<string, string>;

/** A counter — monotonically increasing value. */
export interface Counter {
  /** Increment by delta (default 1). Must be non-negative. */
  add(delta?: number, labels?: MetricLabels): void;
  /** Return current cumulative value for a label set. */
  value(labels?: MetricLabels): number;
}

/** A histogram — distribution of observed values. */
export interface Histogram {
  /** Record an observation. */
  record(value: number, labels?: MetricLabels): void;
  /** Snapshot of recorded statistics for a label set. */
  snapshot(labels?: MetricLabels): HistogramSnapshot;
}

/** Statistics snapshot for a histogram. */
export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** Mean (sum / count), or 0 if count is 0. */
  readonly mean: number;
}

/** A gauge — arbitrary point-in-time value. */
export interface Gauge {
  /** Set to an absolute value. */
  set(value: number, labels?: MetricLabels): void;
  /** Return current value for a label set. */
  value(labels?: MetricLabels): number;
}

// ── Exporter interface ────────────────────────────────────────────────────────

/** A span exporter — receives completed spans. */
export interface SpanExporter {
  /** Name for logging/identification. */
  readonly name: string;
  /** Export a batch of completed spans. Must not throw — swallow and log on failure. */
  export(spans: ReadableSpan[]): Promise<void>;
  /** Flush any buffered spans. */
  flush(): Promise<void>;
  /** Shut down the exporter gracefully. */
  shutdown(): Promise<void>;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Configuration for the RuntimeTracer. */
export interface TracerConfig {
  /** Instrumentation scope (e.g. 'goodvibes-tui'). */
  readonly scope: string;
  /** Exporters to send completed spans to. */
  readonly exporters: SpanExporter[];
  /**
   * Whether to sample all spans (true) or disable tracing (false).
   * Defaults to true when the otel-foundation feature flag is enabled.
   */
  readonly enabled: boolean;
}

/** Configuration for the RuntimeMeter. */
export interface MeterConfig {
  /** Instrumentation scope name (e.g. 'goodvibes-tui'). */
  readonly scope: string;
}

/** Combined telemetry provider configuration. */
export interface TelemetryProviderConfig {
  readonly tracer: TracerConfig;
  readonly meter: MeterConfig;
}
