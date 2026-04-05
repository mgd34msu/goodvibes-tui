/**
 * Telemetry domain state — tracks runtime observability data including
 * correlation IDs, session metrics, and structured event counts.
 *
 * Correlation IDs and structured event counts are tracked from day one.
 */

/** A single structured telemetry event record (lightweight). */
export interface TelemetryEventRecord {
  /** Event type identifier. */
  eventType: string;
  /** Correlation ID linking this event to a trace. */
  correlationId: string;
  /** Subsystem that emitted the event. */
  source: string;
  /** Epoch ms when the event was recorded. */
  timestamp: number;
  /** Optional structured metadata. */
  meta?: Record<string, unknown>;
}

/** Session-level metric aggregates. */
export interface SessionMetrics {
  /** Total turns completed. */
  turns: number;
  /** Total tool calls dispatched. */
  toolCalls: number;
  /** Total tool call failures. */
  toolErrors: number;
  /** Total agents spawned. */
  agentsSpawned: number;
  /** Total input tokens consumed. */
  inputTokens: number;
  /** Total output tokens generated. */
  outputTokens: number;
  /** Total cache read tokens saved. */
  cacheReadTokens: number;
  /** Total permission prompts shown. */
  permissionPrompts: number;
  /** Total permission denials. */
  permissionDenials: number;
  /** Total errors logged. */
  errors: number;
  /** Total warnings logged. */
  warnings: number;
}

/** OTel-compatible trace context (populated when OTel is active). */
export interface TraceContext {
  /** Trace ID (128-bit hex string). */
  traceId: string;
  /** Root span ID (64-bit hex string). */
  rootSpanId: string;
  /** Whether OTel export is active. */
  exportActive: boolean;
  /** OTel collector endpoint. */
  endpoint?: string;
}

/**
 * TelemetryDomainState — runtime observability and metrics.
 */
export interface TelemetryDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Correlation ─────────────────────────────────────────────────────────────
  /** Session-level correlation ID (set at session start, never changes). */
  sessionCorrelationId: string;
  /** Current turn correlation ID (changes each turn). */
  currentTurnCorrelationId?: string;
  /** OTel trace context (undefined until OTel is enabled). */
  traceContext?: TraceContext;

  // ── Metrics ──────────────────────────────────────────────────────────────
  /** Accumulated session metrics. */
  sessionMetrics: SessionMetrics;

  // ── Event buffer ──────────────────────────────────────────────────────────
  /**
   * Ring buffer of recent telemetry events (last N, capped for memory).
   * Used for the telemetry dashboard and event replay.
   */
  recentEvents: TelemetryEventRecord[];
  /** Maximum number of events to keep in recentEvents. */
  maxEventBuffer: number;

  // ── DB ────────────────────────────────────────────────────────────────────
  /** Whether the telemetry SQLite DB is available. */
  dbAvailable: boolean;
  /** Path to the telemetry DB file. */
  dbPath?: string;
}

/**
 * Returns the default initial state for the telemetry domain.
 */
export function createInitialTelemetryState(): TelemetryDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    sessionCorrelationId: '',
    currentTurnCorrelationId: undefined,
    traceContext: undefined,
    sessionMetrics: {
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      agentsSpawned: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      permissionPrompts: 0,
      permissionDenials: 0,
      errors: 0,
      warnings: 0,
    },
    recentEvents: [],
    maxEventBuffer: 500,
    dbAvailable: false,
    dbPath: undefined,
  };
}
