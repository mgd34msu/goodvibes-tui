import { afterEach, describe, expect, test } from 'bun:test';
import { createDaemonTelemetryRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon/http/telemetry-routes';
import { RuntimeEventBus, createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TelemetryApiService } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/api';

describe('daemon telemetry routes', () => {
  let telemetryApi: TelemetryApiService | null = null;

  afterEach(() => {
    telemetryApi?.dispose();
    telemetryApi = null;
  });

  test('serves telemetry snapshot, event lists, and OTLP log views', async () => {
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();

    runtimeStore.setState((state) => ({
      ...state,
      session: {
        ...state.session,
        id: 'session-route-test',
        status: 'active',
        startedAt: 1_000,
      },
      telemetry: {
        ...state.telemetry,
        sessionCorrelationId: 'corr-route',
      },
    }));

    telemetryApi = new TelemetryApiService({
      runtimeBus,
      runtimeStore,
    });

    runtimeBus.emit('turn', createEventEnvelope('TURN_SUBMITTED', {
      type: 'TURN_SUBMITTED',
      turnId: 'turn-route',
      prompt: 'route telemetry',
    }, {
      sessionId: 'session-route-test',
      source: 'route-test',
      turnId: 'turn-route',
    }));

    runtimeBus.emit('turn', createEventEnvelope('TURN_COMPLETED', {
      type: 'TURN_COMPLETED',
      turnId: 'turn-route',
      response: 'ok',
      stopReason: 'completed',
    }, {
      sessionId: 'session-route-test',
      source: 'route-test',
      turnId: 'turn-route',
    }));

    const handlers = createDaemonTelemetryRouteHandlers({
      telemetryApi,
      resolveAuthenticatedPrincipal: (req: Request) => {
        const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        return token === 'test-token'
          ? {
              principalId: 'tester',
              principalKind: 'token',
              admin: true,
              scopes: ['read:telemetry', 'read:telemetry-sensitive'],
            }
          : null;
      },
    });

    const snapshotResponse = await handlers.getTelemetrySnapshot(new Request('http://127.0.0.1/api/v1/telemetry?limit=1', {
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as { recent: { events: { items: unknown[] } } };
    expect(snapshot.recent.events.items).toHaveLength(1);

    const tracesResponse = await handlers.getTelemetryTraces(new Request('http://127.0.0.1/api/v1/telemetry/traces?limit=5', {
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(tracesResponse.status).toBe(200);
    const traces = await tracesResponse.json() as { items: unknown[] };
    expect(traces.items).toHaveLength(1);

    const otlpLogsResponse = await handlers.getTelemetryOtlpLogs(new Request('http://127.0.0.1/api/v1/telemetry/otlp/v1/logs?limit=5', {
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(otlpLogsResponse.status).toBe(200);
    const otlpLogs = await otlpLogsResponse.json() as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    expect(otlpLogs.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(2);
  });

  test('rejects raw telemetry access without elevated telemetry scope', async () => {
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();
    telemetryApi = new TelemetryApiService({
      runtimeBus,
      runtimeStore,
    });

    const handlers = createDaemonTelemetryRouteHandlers({
      telemetryApi,
      resolveAuthenticatedPrincipal: (req: Request) => {
        const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        return token === 'limited-token'
          ? {
              principalId: 'limited',
              principalKind: 'user',
              admin: false,
              scopes: ['read:telemetry'],
            }
          : null;
      },
    });

    const response = await handlers.getTelemetrySnapshot(new Request('http://127.0.0.1/api/v1/telemetry?view=raw', {
      headers: { Authorization: 'Bearer limited-token' },
    }));
    expect(response.status).toBe(403);
  });
});
