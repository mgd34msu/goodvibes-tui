import { describe, expect, test } from 'bun:test';
import { createDaemonControlRouteHandlers } from '@pellux/goodvibes-sdk/platform/daemon';

describe('daemon control routes', () => {
  test('builds status and auth responses from injected host services', async () => {
    const handlers = createDaemonControlRouteHandlers({
      authToken: 'shared-token',
      version: '0.18.2',
      sessionCookieName: 'goodvibes_session',
      controlPlaneGateway: {
        getSnapshot: () => ({ ok: true }),
        renderWebUi: () => new Response('<html></html>', { status: 200 }),
        listRecentEvents: (limit) => [{ id: 'evt-1', limit }],
        listSurfaceMessages: () => [{ id: 'msg-1' }],
        listClients: () => [{ id: 'client-1' }],
        createEventStream: () => new Response('stream', { status: 200 }),
      },
      extractAuthToken: (req) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
      resolveAuthenticatedPrincipal: () => ({
        principalId: 'tester',
        principalKind: 'user',
        admin: true,
        scopes: ['read:control-plane'],
      }),
      gatewayMethods: {
        list: () => [{ id: 'tasks.create' }],
        listEvents: () => [{ id: 'runtime.turn' }],
        get: (methodId) => methodId === 'tasks.create'
          ? { dangerous: false, access: 'authenticated' }
          : null,
      },
      getOperatorContract: () => ({ version: 1, product: { id: 'goodvibes' } }),
      inspectInboundTls: (surface) => ({ surface, mode: 'off' }),
      inspectOutboundTls: () => ({ mode: 'system' }),
      invokeGatewayMethodCall: async () => ({ status: 200, ok: true, body: { invoked: true } }),
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => null,
      requireAuthenticatedSession: () => ({ username: 'tester', roles: ['admin'] }),
    }, new Request('http://127.0.0.1/api/control-plane/auth', {
      headers: {
        Authorization: 'Bearer token-123',
        Cookie: 'goodvibes_session=session-123',
      },
    }));

    // getStatus now takes the Request so it can honor the explicit
    // receipts=consume flag; a plain status read is receipt-neutral.
    const statusResponse = await handlers.getStatus(new Request('http://127.0.0.1/api/control-plane/status'));
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json() as { version: string };
    expect(status.version).toBe('0.18.2');

    const authResponse = await handlers.getCurrentAuth(new Request('http://127.0.0.1/api/control-plane/auth', {
      headers: {
        Authorization: 'Bearer token-123',
        Cookie: 'goodvibes_session=session-123',
      },
    }));
    expect(authResponse.status).toBe(200);
    const auth = await authResponse.json() as { authenticated: boolean; roles: string[] };
    expect(auth.authenticated).toBe(true);
    expect(auth.roles).toEqual(['admin']);
  });
});
