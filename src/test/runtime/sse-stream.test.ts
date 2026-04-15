import { describe, expect, test } from 'bun:test';
import { openServerSentEventStream } from '@pellux/goodvibes-sdk/platform/runtime/transports/sse-stream';

function createSseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

describe('openServerSentEventStream', () => {
  test('parses ready and event payloads from an SSE stream', async () => {
    const readyPayloads: unknown[] = [];
    const events: Array<{ eventName: string; payload: unknown }> = [];

    const stop = await openServerSentEventStream(
      createFetchStub(async () => createSseResponse([
        'event: ready\n',
        'data: {"ok":true}\n\n',
        'event: telemetry\n',
        'data: {"type":"tool","ok":true}\n\n',
      ])),
      'http://127.0.0.1:3210/api/v1/telemetry/stream',
      {
        onReady: (payload) => {
          readyPayloads.push(payload);
        },
        onEvent: (eventName, payload) => {
          events.push({ eventName, payload });
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();

    expect(readyPayloads).toEqual([{ ok: true }]);
    expect(events).toEqual([{
      eventName: 'telemetry',
      payload: { type: 'tool', ok: true },
    }]);
  });

  test('attaches transport metadata when the stream cannot be opened', async () => {
    await expect(openServerSentEventStream(
      createFetchStub(async () => createSseResponse(['forbidden'], 403)),
      'http://127.0.0.1:3210/api/control-plane/events?domains=agents',
      {},
    )).rejects.toMatchObject({
      transport: {
        status: 403,
        url: 'http://127.0.0.1:3210/api/control-plane/events?domains=agents',
        method: 'GET',
        body: 'forbidden',
      },
    });
  });

  test('reconnects with the last received event id when configured', async () => {
    const seenLastEventIds: Array<string | null> = [];
    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
    const events: Array<{ eventName: string; payload: unknown }> = [];
    let callCount = 0;

    const stop = await openServerSentEventStream(
      createFetchStub(async (_input, init) => {
        callCount += 1;
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        seenLastEventIds.push(headers.get('last-event-id'));
        if (callCount === 1) {
          return createSseResponse([
            'id: evt-1\n',
            'event: telemetry\n',
            'data: {"step":1}\n\n',
          ]);
        }
        return createSseResponse([
          'id: evt-2\n',
          'event: telemetry\n',
          'data: {"step":2}\n\n',
        ]);
      }),
      'http://127.0.0.1:3210/api/v1/telemetry/stream',
      {
        onEvent: (eventName, payload) => {
          events.push({ eventName, payload });
          if (events.length >= 2) {
            stop();
          }
        },
        onReconnect: (input) => {
          reconnects.push(input);
        },
      },
      {
        reconnect: {
          enabled: true,
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events).toEqual([
      { eventName: 'telemetry', payload: { step: 1 } },
      { eventName: 'telemetry', payload: { step: 2 } },
    ]);
    expect(seenLastEventIds).toEqual([null, 'evt-1']);
    expect(reconnects).toEqual([{ attempt: 1, delayMs: 0 }]);
  });
});
