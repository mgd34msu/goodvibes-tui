import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TelemetryApiService } from '@/runtime/index.ts';


// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('TelemetryApiService', () => {
  let service: TelemetryApiService | null = null;

  afterEach(async () => {
    service?.dispose();
    service = null;
  });

  test('captures canonical telemetry, normalized errors, synthesized spans, and OTLP views', async () => {
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();

    runtimeStore.setState((state) => ({
      ...state,
      session: {
        ...state.session,
        id: 'session-telemetry',
        status: 'active',
        startedAt: 1_000,
      },
      telemetry: {
        ...state.telemetry,
        sessionCorrelationId: 'corr-session',
        currentTurnCorrelationId: 'corr-turn',
        dbAvailable: true,
      },
    }));

    service = new TelemetryApiService({
      runtimeBus,
      runtimeStore,
      eventLimit: 20,
      errorLimit: 10,
      spanLimit: 10,
    });

    runtimeBus.emit('turn', createEventEnvelope('TURN_SUBMITTED', {
      type: 'TURN_SUBMITTED',
      turnId: 'turn-1',
      prompt: 'hello',
    }, {
      sessionId: 'session-telemetry',
      source: 'test-suite',
      traceId: '123e4567-e89b-12d3-a456-426614174000',
      turnId: 'turn-1',
    }));

    runtimeBus.emit('turn', createEventEnvelope('TURN_ERROR', {
      type: 'TURN_ERROR',
      turnId: 'turn-1',
      error: 'provider socket hang up',
      stopReason: 'provider_error',
    }, {
      sessionId: 'session-telemetry',
      source: 'test-suite',
      traceId: '123e4567-e89b-12d3-a456-426614174000',
      turnId: 'turn-1',
    }));

    runtimeBus.emit('transport', createEventEnvelope('TRANSPORT_TERMINAL_FAILURE', {
      type: 'TRANSPORT_TERMINAL_FAILURE',
      transportId: 'daemon',
      error: 'ECONNREFUSED connecting to collector',
    }, {
      sessionId: 'session-telemetry',
      source: 'test-suite',
      traceId: '123e4567-e89b-12d3-a456-426614174000',
    }));

    await flushMicrotasks();
    const snapshot = service.getSnapshot({ limit: 5 });
    expect(snapshot.capabilities.signals.events).toBe(true);
    expect(snapshot.runtime.sessionId).toBe('session-telemetry');
    expect(snapshot.view).toBe('safe');
    expect(snapshot.recent.events.items).toHaveLength(3);
    expect(snapshot.aggregates.totalEvents).toBe(3);
    expect(snapshot.aggregates.totalErrors).toBeGreaterThanOrEqual(2);
    const submitted = snapshot.recent.events.items.find((record) => record.type === 'TURN_SUBMITTED');
    expect((submitted?.payload as { prompt?: string } | undefined)?.prompt).toContain('[REDACTED_TEXT');

    const errors = service.listErrors({ limit: 5 });
    expect(errors).toHaveLength(2);
    const transportError = errors.find((record) => record.type === 'TRANSPORT_TERMINAL_FAILURE');
    expect(transportError?.error?.source).toBe('transport');
    expect(transportError?.error?.category).toBe('network');

    const spans = service.listSpans({ limit: 5 });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('turn.lifecycle');
    expect(spans[0]?.status.code).toBe(2);

    const otlpTraces = service.buildOtlpTraceDocument({ limit: 5 }) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    expect(otlpTraces.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe('turn.lifecycle');

    const otlpLogs = service.buildOtlpLogDocument({ limit: 5 }) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ severityText: string }> }> }>;
    };
    expect(otlpLogs.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(3);
    expect(otlpLogs.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.severityText).toBe('ERROR');

    const otlpMetrics = service.buildOtlpMetricDocument() as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }>;
    };
    expect(otlpMetrics.resourceMetrics[0]?.scopeMetrics[0]?.metrics.some((metric) => metric.name === 'goodvibes.telemetry.events.total')).toBe(true);

    const rawEvents = service.listEvents({ limit: 5, view: 'raw' });
    const rawSubmitted = rawEvents.find((record) => record.type === 'TURN_SUBMITTED');
    expect((rawSubmitted?.payload as { prompt?: string } | undefined)?.prompt).toBe('hello');

    const firstPage = service.listEventPage({ limit: 1 });
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.pageInfo.nextCursor).toBeTruthy();
    const secondPage = service.listEventPage({ limit: 1, cursor: firstPage.pageInfo.nextCursor });
    expect(secondPage.items).toHaveLength(1);
  });
});
