import { describe, expect, test } from 'bun:test';
import { createHttpJsonTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/http-json-transport';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

describe('HttpJsonTransport', () => {
  test('resolves templated paths and GET query parameters', () => {
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetchImpl: createFetchStub(async () => createJsonResponse({ ok: true })),
    });

    const resolved = transport.resolveContractRequest('GET', '/api/sessions/{sessionId}/messages', {
      sessionId: 'session-1',
      limit: 25,
      before: 'cursor-1',
      tags: ['a', 'b'],
      routing: { target: 'main' },
    });

    expect(resolved.method).toBe('GET');
    expect(resolved.body).toBeUndefined();
    expect(resolved.url).toBe(
      'http://127.0.0.1:3210/api/sessions/session-1/messages?limit=25&before=cursor-1&tags=a&tags=b&routing=%7B%22target%22%3A%22main%22%7D',
    );
  });

  test('attaches transport metadata to failed JSON requests', async () => {
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetchImpl: createFetchStub(async () => createJsonResponse({
        error: 'Authentication failed',
        hint: 'wrong token',
      }, 401)),
    });

    await expect(transport.requestJson('/api/accounts')).rejects.toMatchObject({
      message: 'Authentication failed',
      transport: {
        status: 401,
        url: 'http://127.0.0.1:3210/api/accounts',
        method: 'GET',
        body: {
          error: 'Authentication failed',
          hint: 'wrong token',
        },
      },
    });
  });

  test('resolves auth tokens dynamically for each request', async () => {
    const seenAuth: string[] = [];
    let currentToken = 'token-1';
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      getAuthToken: async () => currentToken,
      fetchImpl: createFetchStub(async (_input, init) => {
        const headers = init?.headers instanceof Headers
          ? init.headers
          : new Headers(init?.headers);
        seenAuth.push(headers.get('authorization') ?? '');
        return createJsonResponse({ ok: true });
      }),
    });

    await transport.requestJson('/api/accounts');
    currentToken = 'token-2';
    await transport.requestJson('/api/accounts');

    expect(seenAuth).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  test('retries safe requests on transient failures', async () => {
    let calls = 0;
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      fetchImpl: createFetchStub(async () => {
        calls += 1;
        if (calls < 3) {
          return createJsonResponse({ error: 'service unavailable' }, 503);
        }
        return createJsonResponse({ ok: true });
      }),
    });

    await expect(transport.requestJson<{ ok: boolean }>('/api/accounts')).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });
});
