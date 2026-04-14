import { describe, expect, test } from 'bun:test';
import { getDistributedNodeHostContract } from '../../runtime/remote/distributed-runtime-contract.ts';
import { createHttpJsonTransport } from '../../runtime/transports/http-json-transport.ts';
import { createPeerRemoteClient } from '../../runtime/transports/peer-remote-client.ts';

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

describe('PeerRemoteClient', () => {
  test('resolves templated peer contract paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'peer-token',
      fetchImpl: createFetchStub(async (input?: unknown, init?: unknown) => {
        calls.push({ url: String(input), init: init as RequestInit | undefined });
        return createJsonResponse({ ok: true });
      }),
    });
    const client = createPeerRemoteClient(transport, getDistributedNodeHostContract());

    await client.work.complete('work-1', {
      status: 'completed',
      result: { ok: true },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3210/api/remote/work/work-1/complete');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({
      status: 'completed',
      result: { ok: true },
    }));
  });

  test('supports simple pairing requests', async () => {
    const transport = createHttpJsonTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetchImpl: createFetchStub(async () => createJsonResponse({
        request: {
          id: 'pair-1',
          peerKind: 'node',
          requestedId: 'node-a',
          label: 'runner-a',
          capabilities: [],
          commands: [],
          requestedBy: 'remote',
          status: 'pending',
          challengePreview: 'preview',
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 2,
          metadata: {},
        },
        challenge: 'challenge-1',
      })),
    });
    const client = createPeerRemoteClient(transport, getDistributedNodeHostContract());

    await expect(client.pairing.request({
      peerKind: 'node',
      label: 'runner-a',
      requestedId: 'node-a',
    })).resolves.toMatchObject({
      request: { id: 'pair-1' },
      challenge: 'challenge-1',
    });
  });
});
