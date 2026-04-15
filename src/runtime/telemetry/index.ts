/**
 * Runtime telemetry module — OTel-compatible tracing and metrics.
 *
 * Provides a lightweight telemetry provider factory that wires together
 * a RuntimeTracer and RuntimeMeter with configurable exporters.
 *
 * @example
 * ```ts
 * import { createTelemetryProvider } from './index.ts';
 * import { LocalLedgerExporter } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/exporters/index';
 *
 * const { tracer, meter } = createTelemetryProvider({
 *   tracer: {
 *     scope: 'goodvibes-tui',
 *     enabled: true,
 *     exporters: [new LocalLedgerExporter({ filePath: '/tmp/spans.jsonl' })],
 *   },
 *   meter: { scope: 'goodvibes-tui' },
 * });
 * ```
 */
import { RuntimeTracer } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/tracer';
import { RuntimeMeter } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/meter';
import type { TelemetryProviderConfig } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/types';

// Re-export all public types
export type {
  AttributeValue,
  SpanAttributes,
  SpanContext,
  SpanEvent,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  ReadableSpan,
  Span,
  SpanExporter,
  Counter,
  Histogram,
  HistogramSnapshot,
  Gauge,
  MetricLabels,
  TracerConfig,
  MeterConfig,
  TelemetryProviderConfig,
} from '@pellux/goodvibes-sdk/platform/runtime/telemetry/types';
export { SpanStatusCode as SpanStatusCodes, SpanKind as SpanKinds } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/types';

// Re-export tracer and meter classes
export { RuntimeTracer } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/tracer';
export { RuntimeMeter } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/meter';
export type {
  TelemetrySeverity,
  TelemetryViewMode,
  TelemetryFilter,
  TelemetryRecord,
  TelemetryPageInfo,
  TelemetryListResponse,
  TelemetryCapabilities,
  TelemetryAggregates,
  TelemetryRuntimeSnapshot,
  TelemetrySnapshot,
} from './api.ts';
export { TelemetryApiService } from './api.ts';

// Re-export span helpers
export type {
  TurnSpanContext,
  TurnSpanEndContext,
  ToolSpanContext,
  ToolSpanEndContext,
  ToolPhase,
  LlmSpanContext,
  LlmSpanEndContext,
  LlmTokenUsage,
  PluginSpanContext,
  PluginSpanEndContext,
  PluginPhase,
  McpSpanContext,
  McpSpanEndContext,
  McpPhase,
  TransportSpanContext,
  TransportSpanEndContext,
  TransportPhase,
  TaskSpanContext,
  TaskSpanEndContext,
  TaskPhase,
  AgentSpanContext,
  AgentSpanEndContext,
  AgentPhase,
  PermissionSpanContext,
  PermissionSpanEndContext,
  PermissionPhase,
  SessionSpanContext,
  SessionSpanEndContext,
  SessionPhase,
  CompactionSpanContext,
  CompactionSpanEndContext,
  CompactionPhase,
  HealthCascadeSpanContext,
} from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/index';
export {
  startTurnSpan,
  endTurnSpan,
  startToolSpan,
  recordToolPhase,
  endToolSpan,
  startLlmSpan,
  recordLlmStreamStart,
  endLlmSpan,
  startPluginSpan,
  recordPluginPhase,
  endPluginSpan,
  startMcpSpan,
  recordMcpPhase,
  endMcpSpan,
  startTransportSpan,
  recordTransportPhase,
  endTransportSpan,
  startTaskSpan,
  recordTaskPhase,
  endTaskSpan,
  startAgentSpan,
  recordAgentPhase,
  endAgentSpan,
  startPermissionSpan,
  recordPermissionPhase,
  endPermissionSpan,
  startSessionSpan,
  recordSessionPhase,
  endSessionSpan,
  startCompactionSpan,
  recordCompactionPhase,
  endCompactionSpan,
  recordHealthCascadeSpan,
} from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/index';

// Re-export exporters
export type { LocalLedgerConfig, ConsoleVerbosity, ConsoleExporterConfig } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/exporters/index';
export { LocalLedgerExporter, ConsoleExporter } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/exporters/index';

// Re-export instrumentation
export type { InstrumentationHandle } from './instrumentation/index.ts';
export { DomainBridge, createInstrumentation } from './instrumentation/index.ts';

/** Alias for TelemetryProviderConfig to match the factory parameter name. */
export type TelemetryConfig = TelemetryProviderConfig;

/**
 * Create a telemetry provider — a paired RuntimeTracer and RuntimeMeter.
 *
 * When no config is supplied, a no-op provider is returned:
 * - Tracer is disabled (all spans are no-ops).
 * - Meter is initialised with the default scope `'goodvibes-tui'`.
 *
 * @param config - Optional telemetry provider configuration.
 * @returns An object with `tracer` and `meter` instances.
 */
export function createTelemetryProvider(config?: TelemetryConfig): {
  tracer: RuntimeTracer;
  meter: RuntimeMeter;
} {
  const tracer = new RuntimeTracer(
    config?.tracer ?? {
      scope: 'goodvibes-tui',
      enabled: false,
      exporters: [],
    },
  );

  const meter = new RuntimeMeter(
    config?.meter ?? {
      scope: 'goodvibes-tui',
    },
  );

  return { tracer, meter };
}
