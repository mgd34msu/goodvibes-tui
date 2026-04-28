import { describe, expect, mock, test } from 'bun:test';
import {
  createHostRequestFailureResponse,
  createSafeHostServeFactory,
} from '../../daemon/safe-serve.ts';

type CapturedFetch = (
  request: Request,
  server: unknown,
) => Response | undefined | Promise<Response | undefined>;

describe('safe host serve factory', () => {
  test('turns thrown request handler failures into bounded JSON responses', async () => {
    let capturedFetch: CapturedFetch | undefined;
    const baseServeFactory = mock((options: unknown) => {
      capturedFetch = (options as { fetch?: CapturedFetch }).fetch;
      return { stop: mock(() => undefined) };
    });
    const serveFactory = createSafeHostServeFactory('test daemon', baseServeFactory as unknown as typeof Bun.serve);

    serveFactory({
      port: 0,
      fetch: async () => {
        throw new Error('home graph sync failed');
      },
    } as Parameters<typeof Bun.serve>[0]);

    expect(capturedFetch).toBeDefined();
    const response = await capturedFetch?.(new Request('http://127.0.0.1:3421/api/homeassistant/home-graph/sync', {
      method: 'POST',
    }), {});

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(500);
    const body = await response?.json() as { error: string; code: string };
    expect(body).toEqual({
      error: 'home graph sync failed',
      code: 'HOST_REQUEST_HANDLER_FAILED',
    });
  });

  test('preserves successful request handler responses', async () => {
    let capturedFetch: CapturedFetch | undefined;
    const baseServeFactory = mock((options: unknown) => {
      capturedFetch = (options as { fetch?: CapturedFetch }).fetch;
      return { stop: mock(() => undefined) };
    });
    const serveFactory = createSafeHostServeFactory('test daemon', baseServeFactory as unknown as typeof Bun.serve);

    serveFactory({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    } as Parameters<typeof Bun.serve>[0]);

    expect(capturedFetch).toBeDefined();
    const response = await capturedFetch?.(new Request('http://127.0.0.1:3421/status'), {});

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
  });

  test('failure response does not expose source snippets or stack frames', async () => {
    const error = new Error('Cannot read properties of undefined');
    error.stack = [
      'TypeError: Cannot read properties of undefined',
      '    at normalizeSpaceComponent (/$bunfs/root/goodvibes:661332:27)',
      '    at buildHomeGraphNodeInput (/$bunfs/root/goodvibes:661632:85)',
    ].join('\n');

    const response = createHostRequestFailureResponse(
      'test daemon',
      new Request('http://127.0.0.1:3421/api/homeassistant/home-graph/sync', { method: 'POST' }),
      error,
    );

    const text = await response.text();
    expect(text).toContain('Cannot read properties of undefined');
    expect(text).not.toContain('$bunfs');
    expect(text).not.toContain('normalizeSpaceComponent');
    expect(text).not.toContain('value.trim');
  });
});
