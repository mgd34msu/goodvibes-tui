import { VERSION } from '../../version.ts';
import { normalizeError, type NormalizedError } from '../../utils/error-display.ts';
import type { ErrorSource } from '../../types/errors.ts';
import type {
  AnyRuntimeEvent,
  RuntimeEventBus,
  RuntimeEventDomain,
  RuntimeEventEnvelope,
} from '../events/index.ts';
import type { RuntimeStore } from '../store/index.ts';
import type { TelemetryDomainState } from '../store/domains/telemetry.ts';
import type {
  AttributeValue,
  ReadableSpan,
  SpanAttributes,
  SpanEvent,
  SpanKind,
  SpanStatus,
} from './types.ts';
import { SpanKind as SpanKinds, SpanStatusCode } from './types.ts';
import {
  ALL_DOMAINS,
  appendBounded,
  buildAttributes,
  buildListResponse,
  buildOtlpLogDocumentFromRecords,
  buildOtlpMetricDocumentFromState,
  buildOtlpTraceDocumentFromSpans,
  buildRecordId,
  buildSpanCursor,
  buildSpanId,
  clampLimit,
  DEFAULT_ERROR_LIMIT,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_SPAN_LIMIT,
  extractErrorCandidate,
  extractProvider,
  extractRecordSequence,
  inferErrorSource,
  inferSeverity,
  isErrorEventType,
  normalizePayload,
  normalizeTraceId,
  sanitizeRecord,
  sanitizeSpan,
  SERVICE_NAME,
  summarizePayload,
  toAttributeValue,
  toObjectMap,
} from './api-helpers.ts';

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error';
export type TelemetryViewMode = 'safe' | 'raw';

export interface TelemetryFilter {
  readonly limit?: number;
  readonly since?: number;
  readonly until?: number;
  readonly domains?: readonly RuntimeEventDomain[];
  readonly eventTypes?: readonly string[];
  readonly severity?: TelemetrySeverity;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly cursor?: string;
  readonly view?: TelemetryViewMode;
}

export interface TelemetryRecord {
  readonly id: string;
  readonly domain: RuntimeEventDomain;
  readonly type: string;
  readonly timestamp: number;
  readonly severity: TelemetrySeverity;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly source: string;
  readonly message: string;
  readonly payload: unknown;
  readonly attributes: Record<string, unknown>;
  readonly error?: NormalizedError;
}

export interface TelemetryCapabilities {
  readonly signals: {
    readonly events: true;
    readonly errors: true;
    readonly metrics: true;
    readonly traces: boolean;
  };
  readonly encodings: {
    readonly json: true;
    readonly sse: true;
    readonly otlpJson: {
      readonly traces: true;
      readonly metrics: true;
      readonly logs: true;
    };
  };
}

export interface TelemetryAggregates {
  readonly totalEvents: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly totalSpans: number;
  readonly byDomain: Readonly<Record<string, number>>;
  readonly byEventType: Readonly<Record<string, number>>;
  readonly errorsByCategory: Readonly<Record<string, number>>;
}

export interface TelemetryRuntimeSnapshot {
  readonly sessionId: string;
  readonly sessionStatus: string;
  readonly traceContext?: TelemetryDomainState['traceContext'];
  readonly sessionCorrelationId: string;
  readonly currentTurnCorrelationId?: string;
  readonly dbAvailable: boolean;
  readonly dbPath?: string;
  readonly tasks: {
    readonly total: number;
    readonly queued: number;
    readonly running: number;
    readonly blocked: number;
  };
  readonly agents: {
    readonly total: number;
    readonly active: number;
  };
  readonly approvals: {
    readonly pending: number;
  };
}

export interface TelemetrySnapshot {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly generatedAt: number;
  readonly service: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: TelemetryCapabilities;
  readonly runtime: TelemetryRuntimeSnapshot;
  readonly sessionMetrics: TelemetryDomainState['sessionMetrics'];
  readonly aggregates: TelemetryAggregates;
  readonly recent: {
    readonly events: TelemetryListResponse<TelemetryRecord>;
    readonly errors: TelemetryListResponse<TelemetryRecord>;
    readonly spans: TelemetryListResponse<ReadableSpan>;
  };
}

export interface TelemetryPageInfo {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly cursor?: string;
  readonly nextCursor?: string;
}

export interface TelemetryListResponse<T> {
  readonly version: 1;
  readonly view: TelemetryViewMode;
  readonly rawAccessible: boolean;
  readonly items: readonly T[];
  readonly pageInfo: TelemetryPageInfo;
}

interface ActiveSyntheticSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTimeMs: number;
  readonly attributes: SpanAttributes;
}

interface TelemetryApiServiceOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly eventLimit?: number;
  readonly errorLimit?: number;
  readonly spanLimit?: number;
}

export class TelemetryApiService {
  private readonly runtimeBus: RuntimeEventBus;
  private readonly runtimeStore: RuntimeStore;
  private readonly eventLimit: number;
  private readonly errorLimit: number;
  private readonly spanLimit: number;
  private readonly records: TelemetryRecord[] = [];
  private readonly errors: TelemetryRecord[] = [];
  private readonly spans: ReadableSpan[] = [];
  private readonly eventCountsByDomain = new Map<string, number>();
  private readonly eventCountsByType = new Map<string, number>();
  private readonly errorCountsByCategory = new Map<string, number>();
  private readonly subscribers = new Set<(record: TelemetryRecord) => void>();
  private readonly unsubs: Array<() => void> = [];
  private readonly activeTurnSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeTaskSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeAgentSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly activeToolSpans = new Map<string, ActiveSyntheticSpan>();
  private readonly turnSpanIds = new Map<string, string>();
  private readonly taskSpanIds = new Map<string, string>();
  private readonly agentSpanIds = new Map<string, string>();
  private seq = 0;

  constructor(options: TelemetryApiServiceOptions) {
    this.runtimeBus = options.runtimeBus;
    this.runtimeStore = options.runtimeStore;
    this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    this.errorLimit = options.errorLimit ?? DEFAULT_ERROR_LIMIT;
    this.spanLimit = options.spanLimit ?? DEFAULT_SPAN_LIMIT;
    this.subscribeAllDomains();
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.subscribers.clear();
    this.activeTurnSpans.clear();
    this.activeTaskSpans.clear();
    this.activeAgentSpans.clear();
    this.activeToolSpans.clear();
  }

  subscribe(listener: (record: TelemetryRecord) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  getCapabilities(): TelemetryCapabilities {
    return {
      signals: {
        events: true,
        errors: true,
        metrics: true,
        traces: this.spans.length > 0,
      },
      encodings: {
        json: true,
        sse: true,
        otlpJson: {
          traces: true,
          metrics: true,
          logs: true,
        },
      },
    };
  }

  getSnapshot(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetrySnapshot {
    const state = this.runtimeStore.getState();
    const telemetry = state.telemetry;
    const limit = clampLimit(filter.limit, 20);
    return {
      version: 1,
      view,
      rawAccessible,
      generatedAt: Date.now(),
      service: {
        name: SERVICE_NAME,
        version: VERSION,
      },
      capabilities: this.getCapabilities(),
      runtime: {
        sessionId: state.session.id,
        sessionStatus: state.session.status,
        traceContext: telemetry.traceContext,
        sessionCorrelationId: telemetry.sessionCorrelationId,
        ...(telemetry.currentTurnCorrelationId ? { currentTurnCorrelationId: telemetry.currentTurnCorrelationId } : {}),
        dbAvailable: telemetry.dbAvailable,
        ...(telemetry.dbPath ? { dbPath: telemetry.dbPath } : {}),
        tasks: {
          total: state.tasks.tasks.size,
          queued: state.tasks.queuedIds.length,
          running: state.tasks.runningIds.length,
          blocked: state.tasks.blockedIds.length,
        },
        agents: {
          total: state.agents.agents.size,
          active: state.agents.activeAgentIds.length,
        },
        approvals: {
          pending: state.permissions.awaitingDecision ? 1 : 0,
        },
      },
      sessionMetrics: telemetry.sessionMetrics,
      aggregates: this.getAggregates(),
      recent: {
        events: this.listEventPage({ ...filter, limit }, view, rawAccessible),
        errors: this.listErrorPage({ ...filter, limit }, view, rawAccessible),
        spans: this.listSpanPage({ ...filter, limit }, view, rawAccessible),
      },
    };
  }

  getAggregates(): TelemetryAggregates {
    const totalErrors = [...this.errorCountsByCategory.values()].reduce((sum, count) => sum + count, 0);
    const totalWarnings = this.listEvents({ severity: 'warn', limit: this.records.length }).length;
    return {
      totalEvents: this.records.length,
      totalErrors,
      totalWarnings,
      totalSpans: this.spans.length,
      byDomain: toObjectMap(this.eventCountsByDomain),
      byEventType: toObjectMap(this.eventCountsByType),
      errorsByCategory: toObjectMap(this.errorCountsByCategory),
    };
  }

  listEvents(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly TelemetryRecord[] {
    return this.listEventPage(filter, view, view === 'raw').items;
  }

  listErrors(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly TelemetryRecord[] {
    return this.listErrorPage(filter, view, view === 'raw').items;
  }

  listSpans(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): readonly ReadableSpan[] {
    return this.listSpanPage(filter, view, view === 'raw').items;
  }

  listEventPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    const { items, pageInfo } = this.applyRecordFilter(this.records, filter, view);
    return buildListResponse(items, view, rawAccessible, pageInfo);
  }

  listErrorPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<TelemetryRecord> {
    const { items, pageInfo } = this.applyRecordFilter(this.errors, filter, view);
    return buildListResponse(items, view, rawAccessible, pageInfo);
  }

  listSpanPage(
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): TelemetryListResponse<ReadableSpan> {
    const { items, pageInfo } = this.applySpanFilter(filter, view);
    return buildListResponse(items, view, rawAccessible, pageInfo);
  }

  createStream(
    request: Request,
    filter: TelemetryFilter = {},
    view: TelemetryViewMode = filter.view ?? 'safe',
    rawAccessible = view === 'raw',
  ): Response {
    const encoder = new TextEncoder();
    let unsub = (): void => {};
    const requestedCursor = request.headers.get('last-event-id')?.trim() || filter.cursor;
    if (requestedCursor) {
      this.resolveCursor(this.records, requestedCursor);
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (requestedCursor) {
          const replay = this.listEventPage({
            ...filter,
            cursor: requestedCursor,
            limit: clampLimit(filter.limit, 100),
          }, view, rawAccessible);
          for (const record of [...replay.items].reverse()) {
            controller.enqueue(encoder.encode(`id: ${record.id}\nevent: telemetry\ndata: ${JSON.stringify(record)}\n\n`));
          }
        }
        unsub = this.subscribe((record) => {
          if (!this.recordMatches(record, filter)) return;
          const projected = sanitizeRecord(record, view);
          controller.enqueue(encoder.encode(`id: ${projected.id}\nevent: telemetry\ndata: ${JSON.stringify(projected)}\n\n`));
        });
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, 15_000);
        request.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          unsub();
          controller.close();
        }, { once: true });
        controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({
          version: 1,
          capabilities: this.getCapabilities(),
          view,
          rawAccessible,
          ...(requestedCursor ? { resumedFrom: requestedCursor } : {}),
        })}\n\n`));
      },
      cancel: () => {
        unsub();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  buildOtlpTraceDocument(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): Record<string, unknown> {
    return buildOtlpTraceDocumentFromSpans(this.listSpans(filter, view));
  }

  buildOtlpLogDocument(filter: TelemetryFilter = {}, view: TelemetryViewMode = filter.view ?? 'safe'): Record<string, unknown> {
    return buildOtlpLogDocumentFromRecords(this.listEvents(filter, view));
  }

  buildOtlpMetricDocument(): Record<string, unknown> {
    return buildOtlpMetricDocumentFromState(this.runtimeStore.getState(), this.getAggregates());
  }

  private subscribeAllDomains(): void {
    for (const domain of ALL_DOMAINS) {
      this.unsubs.push(this.runtimeBus.onDomain(domain, (envelope) => {
        this.handleEnvelope(domain, envelope as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
      }));
    }
  }

  private handleEnvelope(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): void {
    const payload = normalizePayload(envelope.payload);
    const errorCandidate = extractErrorCandidate(payload);
    const normalizedError = errorCandidate && isErrorEventType(envelope.type)
      ? normalizeError(errorCandidate, {
        source: inferErrorSource(domain),
        ...(extractProvider(payload) ? { provider: extractProvider(payload) } : {}),
      })
      : undefined;
    const attributes = buildAttributes(domain, envelope, payload);
    const record: TelemetryRecord = {
      id: buildRecordId(domain, envelope, this.seq++),
      domain,
      type: envelope.type,
      timestamp: envelope.ts,
      severity: inferSeverity(envelope.type, normalizedError),
      traceId: normalizeTraceId(envelope.traceId),
      sessionId: envelope.sessionId,
      ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
      ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
      ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
      source: envelope.source,
      message: summarizePayload(envelope.type, payload),
      payload,
      attributes,
      ...(normalizedError ? { error: normalizedError } : {}),
    };

    appendBounded(this.records, record, this.eventLimit);
    this.eventCountsByDomain.set(domain, (this.eventCountsByDomain.get(domain) ?? 0) + 1);
    this.eventCountsByType.set(envelope.type, (this.eventCountsByType.get(envelope.type) ?? 0) + 1);
    if (normalizedError) {
      appendBounded(this.errors, record, this.errorLimit);
      this.errorCountsByCategory.set(normalizedError.category, (this.errorCountsByCategory.get(normalizedError.category) ?? 0) + 1);
    }
    this.captureSyntheticSpan(record);
    this.notify(record);
  }

  private captureSyntheticSpan(record: TelemetryRecord): void {
    switch (record.type) {
      case 'TURN_SUBMITTED':
        if (record.turnId) {
          const spanId = buildSpanId(`turn:${record.turnId}`);
          this.turnSpanIds.set(record.turnId, spanId);
          this.activeTurnSpans.set(record.turnId, {
            name: 'turn.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TASK_STARTED':
        if (record.taskId) {
          const spanId = buildSpanId(`task:${record.taskId}`);
          this.taskSpanIds.set(record.taskId, spanId);
          this.activeTaskSpans.set(record.taskId, {
            name: 'task.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'AGENT_SPAWNING':
      case 'AGENT_RUNNING':
        if (record.agentId && !this.activeAgentSpans.has(record.agentId)) {
          const spanId = buildSpanId(`agent:${record.agentId}`);
          const parentSpanId = record.taskId ? this.taskSpanIds.get(record.taskId) : undefined;
          this.agentSpanIds.set(record.agentId, spanId);
          this.activeAgentSpans.set(record.agentId, {
            name: 'agent.lifecycle',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TOOL_EXECUTING':
        if (typeof record.attributes.callId === 'string') {
          const callId = record.attributes.callId;
          const spanId = buildSpanId(`tool:${callId}`);
          const parentSpanId = record.agentId
            ? this.agentSpanIds.get(record.agentId)
            : record.taskId
              ? this.taskSpanIds.get(record.taskId)
              : record.turnId
                ? this.turnSpanIds.get(record.turnId)
                : undefined;
          this.activeToolSpans.set(callId, {
            name: 'tool.execute',
            kind: SpanKinds.INTERNAL,
            traceId: record.traceId,
            spanId,
            ...(parentSpanId ? { parentSpanId } : {}),
            startTimeMs: record.timestamp,
            attributes: this.buildSpanAttributes(record, { startEventType: record.type }),
          });
        }
        return;
      case 'TURN_COMPLETED':
      case 'TURN_ERROR':
      case 'TURN_CANCEL':
      case 'PREFLIGHT_FAIL':
        this.completeSyntheticSpan(record.turnId, this.activeTurnSpans, record, 'turn.lifecycle');
        return;
      case 'TASK_COMPLETED':
      case 'TASK_FAILED':
      case 'TASK_CANCELLED':
        this.completeSyntheticSpan(record.taskId, this.activeTaskSpans, record, 'task.lifecycle');
        return;
      case 'AGENT_COMPLETED':
      case 'AGENT_FAILED':
      case 'AGENT_CANCELLED':
        this.completeSyntheticSpan(record.agentId, this.activeAgentSpans, record, 'agent.lifecycle');
        return;
      case 'TOOL_SUCCEEDED':
      case 'TOOL_FAILED':
      case 'TOOL_CANCELLED': {
        const callId = typeof record.attributes.callId === 'string' ? record.attributes.callId : undefined;
        this.completeSyntheticSpan(callId, this.activeToolSpans, record, 'tool.execute');
        return;
      }
      default:
        return;
    }
  }

  private completeSyntheticSpan(
    key: string | undefined,
    activeMap: Map<string, ActiveSyntheticSpan>,
    record: TelemetryRecord,
    defaultName: string,
  ): void {
    const active = key ? activeMap.get(key) : undefined;
    const durationMs = typeof record.attributes.durationMs === 'number' ? Math.max(0, record.attributes.durationMs) : undefined;
    const synthesized: ActiveSyntheticSpan = active ?? {
      name: defaultName,
      kind: SpanKinds.INTERNAL,
      traceId: record.traceId,
      spanId: buildSpanId(`${defaultName}:${key ?? record.id}`),
      startTimeMs: durationMs !== undefined ? Math.max(0, record.timestamp - durationMs) : record.timestamp,
      attributes: this.buildSpanAttributes(record, { synthesized: true }),
    };
    if (key) activeMap.delete(key);

    const status: SpanStatus = record.error
      ? { code: SpanStatusCode.ERROR, message: record.error.summary }
      : { code: SpanStatusCode.OK };
    const events: SpanEvent[] = [
      {
        name: record.type,
        timestamp: record.timestamp,
        attributes: Object.fromEntries(
          Object.entries(this.buildSpanAttributes(record, { endEventType: record.type }))
            .map(([spanKey, value]) => [spanKey, toAttributeValue(value)])
            .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
        ),
      },
    ];

    appendBounded(this.spans, Object.freeze({
      name: synthesized.name,
      kind: synthesized.kind,
      spanContext: {
        traceId: synthesized.traceId,
        spanId: synthesized.spanId,
        isValid: true,
      },
      ...(synthesized.parentSpanId ? { parentSpanId: synthesized.parentSpanId } : {}),
      startTimeMs: synthesized.startTimeMs,
      endTimeMs: record.timestamp,
      durationMs: Math.max(0, record.timestamp - synthesized.startTimeMs),
      attributes: {
        ...synthesized.attributes,
        ...Object.fromEntries(
          Object.entries(this.buildSpanAttributes(record, { endEventType: record.type }))
            .map(([spanKey, value]) => [spanKey, toAttributeValue(value)])
            .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined),
        ),
      },
      events,
      status,
      instrumentationScope: `${SERVICE_NAME}/telemetry`,
    }), this.spanLimit);
  }

  private buildSpanAttributes(record: TelemetryRecord, extra: Record<string, unknown> = {}): SpanAttributes {
    const attributes: SpanAttributes = {
      telemetryDomain: record.domain,
      eventType: record.type,
      source: record.source,
      severity: record.severity,
      ...(record.turnId ? { turnId: record.turnId } : {}),
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...extra,
    };
    for (const [key, value] of Object.entries(record.attributes)) {
      const attributeValue = toAttributeValue(value);
      if (attributeValue !== undefined) {
        attributes[key] = attributeValue;
      }
    }
    if (record.error) {
      attributes.errorCategory = record.error.category;
      attributes.errorSource = record.error.source;
      if (record.error.code) attributes.errorCode = record.error.code;
      if (record.error.statusCode !== undefined) attributes.errorStatusCode = record.error.statusCode;
      if (record.error.provider) attributes.errorProvider = record.error.provider;
      if (record.error.operation) attributes.errorOperation = record.error.operation;
    }
    return attributes;
  }

  private applyRecordFilter(
    records: readonly TelemetryRecord[],
    filter: TelemetryFilter,
    view: TelemetryViewMode,
  ): { items: readonly TelemetryRecord[]; pageInfo: TelemetryPageInfo } {
    const filtered = [...records].filter((record) => this.recordMatches(record, filter));
    filtered.sort((left, right) => {
      const timestampDelta = right.timestamp - left.timestamp;
      if (timestampDelta !== 0) return timestampDelta;
      return extractRecordSequence(right) - extractRecordSequence(left);
    });
    const limit = clampLimit(filter.limit, 100);
    const startIndex = filter.cursor ? this.resolveCursor(filtered, filter.cursor) + 1 : 0;
    const page = filtered.slice(startIndex, startIndex + limit);
    const next = filtered[startIndex + limit];
    return {
      items: page.map((record) => sanitizeRecord(record, view)),
      pageInfo: {
        limit,
        returned: page.length,
        hasMore: Boolean(next),
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
        ...(next ? { nextCursor: next.id } : {}),
      },
    };
  }

  private applySpanFilter(
    filter: TelemetryFilter,
    view: TelemetryViewMode,
  ): { items: readonly ReadableSpan[]; pageInfo: TelemetryPageInfo } {
    const normalizedTraceId = filter.traceId ? normalizeTraceId(filter.traceId) : undefined;
    const filtered = [...this.spans].filter((span) => {
      if (filter.since !== undefined && span.startTimeMs < filter.since) return false;
      if (filter.until !== undefined && span.endTimeMs > filter.until) return false;
      if (normalizedTraceId && span.spanContext.traceId !== normalizedTraceId) return false;
      if (filter.turnId !== undefined && span.attributes.turnId !== filter.turnId) return false;
      if (filter.agentId !== undefined && span.attributes.agentId !== filter.agentId) return false;
      if (filter.taskId !== undefined && span.attributes.taskId !== filter.taskId) return false;
      if (filter.eventTypes && filter.eventTypes.length > 0) {
        const startEventType = typeof span.attributes.startEventType === 'string' ? span.attributes.startEventType : '';
        if (!filter.eventTypes.includes(startEventType)) return false;
      }
      return true;
    }).sort((left, right) => right.endTimeMs - left.endTimeMs);
    const limit = clampLimit(filter.limit, 100);
    const startIndex = filter.cursor ? this.resolveSpanCursor(filtered, filter.cursor) + 1 : 0;
    const page = filtered.slice(startIndex, startIndex + limit);
    const next = filtered[startIndex + limit];
    return {
      items: page.map((span) => sanitizeSpan(span, view)),
      pageInfo: {
        limit,
        returned: page.length,
        hasMore: Boolean(next),
        ...(filter.cursor ? { cursor: filter.cursor } : {}),
        ...(next ? { nextCursor: buildSpanCursor(next) } : {}),
      },
    };
  }

  private recordMatches(record: TelemetryRecord, filter: TelemetryFilter): boolean {
    if (filter.since !== undefined && record.timestamp < filter.since) return false;
    if (filter.until !== undefined && record.timestamp > filter.until) return false;
    if (filter.domains && filter.domains.length > 0 && !filter.domains.includes(record.domain)) return false;
    if (filter.eventTypes && filter.eventTypes.length > 0 && !filter.eventTypes.includes(record.type)) return false;
    if (filter.severity && record.severity !== filter.severity) return false;
    if (filter.traceId && record.traceId !== normalizeTraceId(filter.traceId)) return false;
    if (filter.sessionId && record.sessionId !== filter.sessionId) return false;
    if (filter.turnId && record.turnId !== filter.turnId) return false;
    if (filter.agentId && record.agentId !== filter.agentId) return false;
    if (filter.taskId && record.taskId !== filter.taskId) return false;
    return true;
  }

  private resolveCursor(records: readonly TelemetryRecord[], cursor: string): number {
    const index = records.findIndex((record) => record.id === cursor);
    if (index >= 0) return index;
    throw new Error(`Invalid telemetry cursor: ${cursor}`);
  }

  private resolveSpanCursor(spans: readonly ReadableSpan[], cursor: string): number {
    const index = spans.findIndex((span) => buildSpanCursor(span) === cursor);
    if (index >= 0) return index;
    throw new Error(`Invalid telemetry cursor: ${cursor}`);
  }

  private notify(record: TelemetryRecord): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(record);
      } catch {
        // Telemetry subscribers must never break the runtime.
      }
    }
  }
}
