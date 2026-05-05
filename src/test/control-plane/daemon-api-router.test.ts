import { describe, expect, test } from 'bun:test';
import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-sdk/platform/control-plane';

describe('daemon api router', () => {
  test('dispatches telemetry event routes to the matching handler', async () => {
    const response = await dispatchDaemonApiRoutes(
      new Request('http://127.0.0.1/api/v1/telemetry/events', { method: 'GET' }),
      {
        getTelemetryEvents: () => Response.json({ ok: true }),
      } as never,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
  });
});
