import { createHash } from 'node:crypto';
import { VERSION } from '../../version.ts';
import type { ErrorSource } from '../../types/errors.ts';
import type { NormalizedError } from '../../utils/error-display.ts';
import { redactStructuredData } from '../../utils/redaction.ts';
import type {
  AnyRuntimeEvent,
  RuntimeEventDomain,
  RuntimeEventEnvelope,
} from '../events/index.ts';
import type { RuntimeStore } from '../store/index.ts';
import type {
  AttributeValue,
  ReadableSpan,
  SpanAttributes,
} from './types.ts';
import type {
  TelemetryAggregates,
  TelemetryFilter,
  TelemetryListResponse,
  TelemetryPageInfo,
  TelemetryRecord,
  TelemetrySeverity,
  TelemetryViewMode,
} from './api.ts';

export const SERVICE_NAME = 'goodvibes-tui';
export const DEFAULT_EVENT_LIMIT = 500;
export const DEFAULT_ERROR_LIMIT = 250;
export const DEFAULT_SPAN_LIMIT = 250;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
const EMPTY_TRACE_DOCUMENT = { resourceSpans: [] };
const EMPTY_LOG_DOCUMENT = { resourceLogs: [] };
const EMPTY_METRIC_DOCUMENT = { resourceMetrics: [] };

export const ALL_DOMAINS: readonly RuntimeEventDomain[] = [
  'session',
  'turn',
  'providers',
  'tools',
  'tasks',
  'agents',
  'workflows',
  'orchestration',
  'communication',
  'planner',
  'permissions',
  'plugins',
  'mcp',
  'transport',
  'compaction',
  'ui',
  'ops',
  'forensics',
  'security',
  'automation',
  'routes',
  'control-plane',
  'deliveries',
  'watchers',
  'surfaces',
  'knowledge',
] as const;

function hashHex(value: string, length: number): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length);
}

export function normalizeTraceId(traceId: string | undefined): string {
  if (!traceId || traceId.trim().length === 0) return hashHex('missing-trace-id', 32);
  const normalized = traceId.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (normalized.length === 32) return normalized;
  if (normalized.length > 32) return normalized.slice(0, 32);
  if (normalized.length > 0) return normalized.padEnd(32, '0');
  return hashHex(traceId, 32);
}

export function buildSpanId(seed: string): string {
  return hashHex(seed, 16);
}

export function appendBounded<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) {
    target.splice(0, target.length - limit);
  }
}

export function toAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value as string[];
    if (value.every((item) => typeof item === 'number')) return value as number[];
    if (value.every((item) => typeof item === 'boolean')) return value as boolean[];
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function toOtlpAnyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => toOtlpAnyValue(item as AttributeValue)),
      },
    };
  }
  return { stringValue: String(value) };
}

export function toOtlpAttributes(attributes: Record<string, unknown>): Array<{ key: string; value: Record<string, unknown> }> {
  const otlpAttributes: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, raw] of Object.entries(attributes)) {
    const value = toAttributeValue(raw);
    if (value === undefined) continue;
    otlpAttributes.push({ key, value: toOtlpAnyValue(value) });
  }
  return otlpAttributes;
}

function buildResource(): { attributes: Array<{ key: string; value: Record<string, unknown> }> } {
  return {
    attributes: [
      { key: 'service.name', value: { stringValue: SERVICE_NAME } },
      { key: 'service.version', value: { stringValue: VERSION } },
    ],
  };
}

export function inferSeverity(type: string, error?: NormalizedError): TelemetrySeverity {
  if (error) return 'error';
  if (/(^|_)(WARNING|DEGRADED|BLOCKED|DENIED|REJECTED|QUARANTINED)(_|$)/.test(type)) return 'warn';
  if (/(^|_)(PROGRESS|DELTA|START|STARTED|RUNNING|SYNCING|CONNECTING|INITIALIZING)(_|$)/.test(type)) return 'debug';
  return 'info';
}

export function inferErrorSource(domain: RuntimeEventDomain): ErrorSource {
  switch (domain) {
    case 'providers':
      return 'provider';
    case 'tools':
      return 'tool';
    case 'transport':
      return 'transport';
    case 'permissions':
    case 'security':
      return 'permission';
    default:
      return 'runtime';
  }
}

export function summarizePayload(type: string, payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return type;
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.provider === 'string') parts.push(`provider=${record.provider}`);
  if (typeof record.model === 'string') parts.push(`model=${record.model}`);
  if (typeof record.tool === 'string') parts.push(`tool=${record.tool}`);
  if (typeof record.callId === 'string') parts.push(`call=${record.callId.slice(0, 12)}`);
  if (typeof record.taskId === 'string') parts.push(`task=${record.taskId.slice(0, 12)}`);
  if (typeof record.agentId === 'string') parts.push(`agent=${record.agentId.slice(0, 12)}`);
  if (typeof record.message === 'string') parts.push(record.message);
  if (typeof record.error === 'string') parts.push(record.error);
  if (typeof record.reason === 'string') parts.push(record.reason);
  if (typeof record.durationMs === 'number') parts.push(`${record.durationMs}ms`);
  if (typeof record.progress === 'number') parts.push(`${record.progress}%`);
  return parts.length > 0 ? `${type} ${parts.join(' ')}` : type;
}

export function normalizePayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? { ...(payload as Record<string, unknown>) } : {};
}

export function extractProvider(payload: Record<string, unknown>): string | undefined {
  return typeof payload.provider === 'string' ? payload.provider : undefined;
}

export function extractErrorCandidate(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.error === 'string' && payload.error.trim().length > 0) return payload.error;
  if (typeof payload.message === 'string' && payload.message.trim().length > 0) return payload.message;
  if (typeof payload.reason === 'string' && payload.reason.trim().length > 0) return payload.reason;
  return undefined;
}

export function isErrorEventType(type: string): boolean {
  return /(^|_)(ERROR|FAILED|FAIL|TERMINAL_FAILURE)(_|$)/.test(type);
}

export function buildAttributes(
  domain: RuntimeEventDomain,
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    domain,
    eventType: envelope.type,
    source: envelope.source,
    traceId: envelope.traceId,
    sessionId: envelope.sessionId,
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
    ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
    ...payload,
  };
}

export function buildRecordId(
  domain: RuntimeEventDomain,
  envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  seq: number,
): string {
  return `${domain}:${envelope.type}:${envelope.ts}:${seq}`;
}

export function extractRecordSequence(record: TelemetryRecord): number {
  const lastColon = record.id.lastIndexOf(':');
  if (lastColon < 0) return 0;
  const parsed = Number.parseInt(record.id.slice(lastColon + 1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildSpanCursor(span: ReadableSpan): string {
  return `${span.spanContext.traceId}:${span.spanContext.spanId}:${span.endTimeMs}`;
}

export function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(500, Math.floor(limit ?? fallback)));
}

export function sanitizeRecord(record: TelemetryRecord, view: TelemetryViewMode): TelemetryRecord {
  if (view === 'raw') return structuredClone(record);
  return {
    ...record,
    payload: redactStructuredData(record.payload),
    attributes: redactStructuredData(record.attributes) as Record<string, unknown>,
  };
}

export function sanitizeSpan(span: ReadableSpan, view: TelemetryViewMode): ReadableSpan {
  if (view === 'raw') return structuredClone(span);
  return {
    ...span,
    attributes: redactStructuredData(span.attributes) as SpanAttributes,
    events: span.events.map((event) => ({
      ...event,
      ...(event.attributes ? { attributes: redactStructuredData(event.attributes) as Record<string, AttributeValue> } : {}),
    })),
  };
}

export function buildListResponse<T>(
  items: readonly T[],
  view: TelemetryViewMode,
  rawAccessible: boolean,
  pageInfo: TelemetryPageInfo,
): TelemetryListResponse<T> {
  return {
    version: 1,
    view,
    rawAccessible,
    items,
    pageInfo,
  };
}

export function toObjectMap(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function toOtlpSeverityNumber(severity: TelemetrySeverity): number {
  switch (severity) {
    case 'debug':
      return 5;
    case 'warn':
      return 13;
    case 'error':
      return 17;
    case 'info':
    default:
      return 9;
  }
}

export function buildOtlpTraceDocumentFromSpans(spans: readonly ReadableSpan[]): Record<string, unknown> {
  if (spans.length === 0) return EMPTY_TRACE_DOCUMENT;

  const grouped = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    const scope = span.instrumentationScope || SERVICE_NAME;
    const bucket = grouped.get(scope) ?? [];
    bucket.push(span);
    grouped.set(scope, bucket);
  }

  return {
    resourceSpans: [
      {
        resource: buildResource(),
        scopeSpans: [...grouped.entries()].map(([scope, scopeSpans]) => ({
          scope: { name: scope },
          spans: scopeSpans.map((span) => ({
            traceId: span.spanContext.traceId,
            spanId: span.spanContext.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: span.kind,
            startTimeUnixNano: String(span.startTimeMs * NANOSECONDS_PER_MILLISECOND),
            endTimeUnixNano: String(span.endTimeMs * NANOSECONDS_PER_MILLISECOND),
            attributes: toOtlpAttributes(span.attributes),
            events: span.events.map((event) => ({
              name: event.name,
              timeUnixNano: String(event.timestamp * NANOSECONDS_PER_MILLISECOND),
              attributes: toOtlpAttributes(event.attributes ?? {}),
            })),
            status: {
              code: span.status.code,
              ...(span.status.message ? { message: span.status.message } : {}),
            },
          })),
        })),
      },
    ],
  };
}

export function buildOtlpLogDocumentFromRecords(records: readonly TelemetryRecord[]): Record<string, unknown> {
  if (records.length === 0) return EMPTY_LOG_DOCUMENT;

  return {
    resourceLogs: [
      {
        resource: buildResource(),
        scopeLogs: [
          {
            scope: { name: `${SERVICE_NAME}/telemetry` },
            logRecords: records.map((record) => ({
              timeUnixNano: String(record.timestamp * NANOSECONDS_PER_MILLISECOND),
              severityNumber: toOtlpSeverityNumber(record.severity),
              severityText: record.severity.toUpperCase(),
              body: { stringValue: record.message },
              traceId: record.traceId,
              attributes: toOtlpAttributes({
                ...record.attributes,
                telemetryRecordId: record.id,
                severity: record.severity,
                ...(record.error ? {
                  errorCategory: record.error.category,
                  errorSource: record.error.source,
                  ...(record.error.code ? { errorCode: record.error.code } : {}),
                  ...(record.error.statusCode !== undefined ? { errorStatusCode: record.error.statusCode } : {}),
                  ...(record.error.provider ? { errorProvider: record.error.provider } : {}),
                  ...(record.error.operation ? { errorOperation: record.error.operation } : {}),
                  ...(record.error.phase ? { errorPhase: record.error.phase } : {}),
                  ...(record.error.requestId ? { errorRequestId: record.error.requestId } : {}),
                  ...(record.error.providerCode ? { errorProviderCode: record.error.providerCode } : {}),
                } : {}),
              }),
            })),
          },
        ],
      },
    ],
  };
}

export function buildOtlpMetricDocumentFromState(
  state: ReturnType<RuntimeStore['getState']>,
  aggregates: TelemetryAggregates,
): Record<string, unknown> {
  const now = Date.now();
  const nowUnixNano = String(now * NANOSECONDS_PER_MILLISECOND);
  const startUnixNano = String(Math.max(0, state.session.startedAt ?? now) * NANOSECONDS_PER_MILLISECOND);
  const metrics = [
    {
      name: 'goodvibes.telemetry.events.total',
      description: 'Total telemetry events captured by the GoodVibes telemetry API.',
      unit: '1',
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        isMonotonic: true,
        dataPoints: [
          {
            startTimeUnixNano: startUnixNano,
            timeUnixNano: nowUnixNano,
            asInt: String(aggregates.totalEvents),
          },
        ],
      },
    },
    {
      name: 'goodvibes.telemetry.events.by_domain',
      description: 'Telemetry events grouped by runtime event domain.',
      unit: '1',
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        isMonotonic: true,
        dataPoints: Object.entries(aggregates.byDomain).map(([domain, count]) => ({
          startTimeUnixNano: startUnixNano,
          timeUnixNano: nowUnixNano,
          asInt: String(count),
          attributes: toOtlpAttributes({ domain }),
        })),
      },
    },
    {
      name: 'goodvibes.telemetry.errors.total',
      description: 'Telemetry errors grouped by normalized error category.',
      unit: '1',
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        isMonotonic: true,
        dataPoints: Object.entries(aggregates.errorsByCategory).map(([category, count]) => ({
          startTimeUnixNano: startUnixNano,
          timeUnixNano: nowUnixNano,
          asInt: String(count),
          attributes: toOtlpAttributes({ category }),
        })),
      },
    },
    {
      name: 'goodvibes.telemetry.spans.total',
      description: 'Total synthesized spans retained by the GoodVibes telemetry API.',
      unit: '1',
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        isMonotonic: true,
        dataPoints: [
          {
            startTimeUnixNano: startUnixNano,
            timeUnixNano: nowUnixNano,
            asInt: String(aggregates.totalSpans),
          },
        ],
      },
    },
    {
      name: 'goodvibes.runtime.tasks.active',
      description: 'Currently active runtime tasks.',
      unit: '1',
      gauge: {
        dataPoints: [
          {
            timeUnixNano: nowUnixNano,
            asInt: String(state.tasks.runningIds.length),
          },
        ],
      },
    },
    {
      name: 'goodvibes.runtime.agents.active',
      description: 'Currently active runtime agents.',
      unit: '1',
      gauge: {
        dataPoints: [
          {
            timeUnixNano: nowUnixNano,
            asInt: String(state.agents.activeAgentIds.length),
          },
        ],
      },
    },
    {
      name: 'goodvibes.session.tokens',
      description: 'Session token counters tracked in the telemetry domain.',
      unit: '1',
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
        isMonotonic: true,
        dataPoints: [
          {
            startTimeUnixNano: startUnixNano,
            timeUnixNano: nowUnixNano,
            asInt: String(state.telemetry.sessionMetrics.inputTokens),
            attributes: toOtlpAttributes({ direction: 'input' }),
          },
          {
            startTimeUnixNano: startUnixNano,
            timeUnixNano: nowUnixNano,
            asInt: String(state.telemetry.sessionMetrics.outputTokens),
            attributes: toOtlpAttributes({ direction: 'output' }),
          },
        ],
      },
    },
  ];

  return {
    resourceMetrics: [
      {
        resource: buildResource(),
        scopeMetrics: [
          {
            scope: { name: `${SERVICE_NAME}/telemetry` },
            metrics,
          },
        ],
      },
    ],
  };
}
