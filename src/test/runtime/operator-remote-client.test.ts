import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../../control-plane/method-catalog.ts';
import { buildOperatorContract } from '../../control-plane/operator-contract.ts';
import { createHttpJsonTransport } from '../../runtime/transports/http-json-transport.ts';
import { createOperatorRemoteClient } from '../../runtime/transports/operator-remote-client.ts';

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createFetchStub(factory: () => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

describe('OperatorRemoteClient', () => {
  test('resolves path params and query params from cataloged methods', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'token-123',
      fetchImpl: createFetchStub(async (input?: unknown, init?: unknown) => {
        calls.push({ url: String(input), init: init as RequestInit | undefined });
        return createJsonResponse({ ok: true });
      }),
    });
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const client = createOperatorRemoteClient(transport, contract);

    await client.invoke('sessions.messages.list', {
      sessionId: 'session-1',
      limit: 25,
      before: 'cursor-1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3210/api/sessions/session-1/messages?limit=25&before=cursor-1');
    expect(calls[0]?.init?.method).toBe('GET');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  test('serializes post bodies from cataloged task methods', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetchImpl: createFetchStub(async (input?: unknown, init?: unknown) => {
        calls.push({ url: String(input), init: init as RequestInit | undefined });
        return createJsonResponse({ taskId: 'task-1' });
      }),
    });
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const client = createOperatorRemoteClient(transport, contract);

    await client.tasks.create({
      task: 'ship it',
      sessionId: 'session-1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3210/task');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({
      task: 'ship it',
      sessionId: 'session-1',
    }));
  });
});
