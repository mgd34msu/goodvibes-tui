/**
 * RuntimeTracer — lightweight OTel-compatible span factory.
 *
 * Implements span creation, parent/child relationships, attributes, events,
 * and export without depending on the @opentelemetry/* packages.
 *
 * Design principles:
 * - All public methods are synchronous; export is async fire-and-forget
 * - End-after-end is a no-op (spans are immutable once ended)
 * - Export failures are caught and logged; they never block the runtime
 */
import type {
  Span,
  SpanAttributes,
  SpanContext,
  SpanEvent,
  SpanExporter,
  SpanStatus,
  ReadableSpan,
  TracerConfig,
  AttributeValue,
} from './types.ts';
import { SpanKind, SpanStatusCode } from './types.ts';

// ── ID generation ───────────────────────────────────────────────────────────────

/** Generate a 128-bit trace ID (32-char lowercase hex). */
function generateTraceId(): string {
  return [
    crypto.getRandomValues(new Uint8Array(16)),
  ].map((bytes) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )[0]!;
}

/** Generate a 64-bit span ID (16-char lowercase hex). */
function generateSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Check if a hex string is non-zero. */
function isNonZeroHex(hex: string): boolean {
  return /[1-9a-f]/.test(hex);
}

// ── SpanImpl ──────────────────────────────────────────────────────────────────────

class SpanImpl implements Span {
  readonly spanContext: SpanContext;
  readonly parentSpanId?: string;
  private _ended = false;
  private _attributes: SpanAttributes = {};
  private _events: SpanEvent[] = [];
  private _status: SpanStatus = { code: SpanStatusCode.UNSET };
  private _startTimeMs: number;
  private _endTimeMs = 0;
  private readonly _name: string;
  private readonly _kind: SpanKind;
  private readonly _scope: string;
  private readonly _onEnd: (span: ReadableSpan) => void;

  constructor(opts: {
    name: string;
    kind: SpanKind;
    traceId: string;
    parentSpanId?: string;
    startTimeMs?: number;
    scope: string;
    onEnd: (span: ReadableSpan) => void;
  }) {
    this._name = opts.name;
    this._kind = opts.kind;
    this._scope = opts.scope;
    this._startTimeMs = opts.startTimeMs ?? Date.now();
    this._onEnd = opts.onEnd;
    this.parentSpanId = opts.parentSpanId;
    const spanId = generateSpanId();
    this.spanContext = {
      traceId: opts.traceId,
      spanId,
      isValid: isNonZeroHex(opts.traceId) && isNonZeroHex(spanId),
    };
  }

  get ended(): boolean {
    return this._ended;
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (this._ended) return this;
    this._attributes[key] = value;
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    if (this._ended) return this;
    Object.assign(this._attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes?: SpanAttributes): this {
    if (this._ended) return this;
    this._events.push({ name, timestamp: Date.now(), attributes });
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (this._ended) return this;
    // Only downgrade if current is UNSET; ERROR takes priority over OK
    if (this._status.code === SpanStatusCode.UNSET || status.code === SpanStatusCode.ERROR) {
      this._status = status;
    }
    return this;
  }

  recordException(error: Error): this {
    if (this._ended) return this;
    this.addEvent('exception', {
      'exception.type': error.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack ?? '',
    });
    this.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    return this;
  }

  end(endTimeMs?: number): void {
    if (this._ended) return;
    this._ended = true;
    this._endTimeMs = endTimeMs ?? Date.now();
    this._onEnd(this.toReadable());
  }

  toReadable(): ReadableSpan {
    const endMs = this._endTimeMs > 0 ? this._endTimeMs : Date.now();
    return Object.freeze({
      name: this._name,
      kind: this._kind,
      spanContext: this.spanContext,
      parentSpanId: this.parentSpanId,
      startTimeMs: this._startTimeMs,
      endTimeMs: endMs,
      durationMs: endMs - this._startTimeMs,
      attributes: { ...this._attributes },
      events: [...this._events],
      status: this._status,
      instrumentationScope: this._scope,
    });
  }
}

// ── RuntimeTracer ──────────────────────────────────────────────────────────────

/**
 * RuntimeTracer — creates spans and routes completed spans to exporters.
 *
 * Usage:
 * ```ts
 * const span = tracer.startSpan('turn.lifecycle', { traceId, parentSpanId });
 * span.setAttribute('turn.id', turnId);
 * span.end();
 * ```
 */
export class RuntimeTracer {
  private readonly config: TracerConfig;

  constructor(config: TracerConfig) {
    this.config = config;
  }

  /**
   * Start a new span.
   *
   * @param name - Human-readable span name.
   * @param opts - Optional trace/parent context and kind.
   */
  startSpan(
    name: string,
    opts?: {
      /** Existing trace ID to join. If omitted, a new trace is started. */
      traceId?: string;
      /** Parent span ID. Makes this span a child of the parent. */
      parentSpanId?: string;
      /** Span kind (defaults to INTERNAL). */
      kind?: SpanKind;
      /** Override start time in epoch ms (defaults to Date.now()). */
      startTimeMs?: number;
      /** Initial attributes. */
      attributes?: SpanAttributes;
    }
  ): Span {
    if (!this.config.enabled) {
      // Return a no-op span when tracing is disabled
      return new NoopSpan();
    }

    const traceId = opts?.traceId ?? generateTraceId();
    const span = new SpanImpl({
      name,
      kind: opts?.kind ?? SpanKind.INTERNAL,
      traceId,
      parentSpanId: opts?.parentSpanId,
      startTimeMs: opts?.startTimeMs,
      scope: this.config.scope,
      onEnd: (readable) => this._export([readable]),
    });

    if (opts?.attributes) {
      span.setAttributes(opts.attributes);
    }

    return span;
  }

  /**
   * Flush all exporters. Call during graceful shutdown.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.config.exporters.map((e) => e.flush()));
  }

  /**
   * Shut down all exporters.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.config.exporters.map((e) => e.shutdown()));
  }

  /** Fire-and-forget export to all registered exporters. */
  private _export(spans: ReadableSpan[]): void {
    for (const exporter of this.config.exporters) {
      // Export is fire-and-forget; failures must not propagate
      exporter.export(spans).catch(() => {
        // Export failure — non-fatal, swallowed intentionally
      });
    }
  }
}

// ── NoopSpan ───────────────────────────────────────────────────────────────────────

/** No-op span returned when tracing is disabled. All operations are safe no-ops. */
class NoopSpan implements Span {
  readonly spanContext: SpanContext = {
    traceId: '00000000000000000000000000000000',
    spanId: '0000000000000000',
    isValid: false,
  };
  readonly parentSpanId: undefined;
  readonly ended = false;
  setAttribute(_key: string, _value: AttributeValue): this { return this; }
  setAttributes(_attrs: SpanAttributes): this { return this; }
  addEvent(_name: string, _attributes?: SpanAttributes): this { return this; }
  setStatus(_status: SpanStatus): this { return this; }
  recordException(_error: Error): this { return this; }
  end(_endTimeMs?: number): void { /* no-op */ }
  toReadable(): ReadableSpan {
    return {
      name: 'noop',
      kind: SpanKind.INTERNAL,
      spanContext: this.spanContext,
      parentSpanId: undefined,
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      attributes: {},
      events: [],
      status: { code: SpanStatusCode.UNSET },
      instrumentationScope: 'noop',
    };
  }
}
