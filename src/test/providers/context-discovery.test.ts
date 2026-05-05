/**
 * Public context-window discovery coverage.
 *
 * SDK 0.33 moved probe helpers behind the provider implementation boundary, so
 * the TUI release gate validates the exported discovery behavior instead of
 * importing underscored probe internals.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  discoverContextWindows,
  SERVER_LEVEL_MODEL_ID,
} from '@pellux/goodvibes-sdk/platform/providers';

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, status: 404, json: async () => null } as unknown as Response;
}

function mockFetch(fn: FetchFn): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('discoverContextWindows', () => {
  test('prefers LM Studio context metadata over OpenAI-compatible model list data', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u === 'http://192.168.0.85:1234/api/v1/models') {
        return makeResponse({
          models: [{ key: 'gemma-4-e4b-it@q8_k_xl', max_context_length: 131072 }],
        });
      }
      if (u === 'http://192.168.0.85:1234/v1/models') {
        return makeResponse({
          data: [{ id: 'gemma-4-e4b-it@q8_k_xl', max_model_len: 4096 }],
        });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://192.168.0.85:1234/v1');
    expect(result.get('gemma-4-e4b-it@q8_k_xl')).toBe(131072);
  });

  test('discovers Ollama model context through the public fallback chain', async () => {
    const showBodies: string[] = [];
    globalThis.fetch = mockFetch(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/v1/models')) return notFound();
      if (u.endsWith('/api/tags')) return makeResponse({ models: [{ name: 'llama3:8b' }] });
      if (u.endsWith('/api/show')) {
        showBodies.push(String(init?.body ?? ''));
        return makeResponse({ model_info: { context_length: 8192 } });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:11434');
    expect(result.get('llama3:8b')).toBe(8192);
    expect(JSON.parse(showBodies[0] ?? '{}').name).toBe('llama3:8b');
  });

  test('discovers OpenAI-compatible max_model_len metadata when local probes are absent', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/models')) return notFound();
      if (u.endsWith('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) {
        return makeResponse({ data: [{ id: 'llama-3.1-8b', max_model_len: 32768 }] });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:8000/v1');
    expect(result.get('llama-3.1-8b')).toBe(32768);
  });

  test('falls back to server-level llama.cpp and TGI metadata', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/models')) return notFound();
      if (u.endsWith('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) return notFound();
      if (u.endsWith('/props')) return makeResponse({ n_ctx: 16384 });
      return notFound();
    });

    const llamaCpp = await discoverContextWindows('http://localhost:8080/v1');
    expect(llamaCpp.get(SERVER_LEVEL_MODEL_ID)).toBe(16384);

    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/models')) return notFound();
      if (u.endsWith('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) return notFound();
      if (u.endsWith('/props')) return notFound();
      if (u.endsWith('/info')) return makeResponse({ max_total_tokens: 8192 });
      return notFound();
    });

    const tgi = await discoverContextWindows('http://localhost:8080/v1');
    expect(tgi.get(SERVER_LEVEL_MODEL_ID)).toBe(8192);
  });

  test('probes URLs derived from the provider base URL and returns empty map when all fail', async () => {
    const probedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (url) => {
      probedUrls.push(String(url));
      return notFound();
    });

    const result = await discoverContextWindows('http://192.168.0.85:1234/v1');

    expect(result.size).toBe(0);
    expect(probedUrls).toContain('http://192.168.0.85:1234/api/v1/models');
    expect(probedUrls).toContain('http://192.168.0.85:1234/api/tags');
    expect(probedUrls).toContain('http://192.168.0.85:1234/v1/models');
    expect(probedUrls).toContain('http://192.168.0.85:1234/props');
    expect(probedUrls).toContain('http://192.168.0.85:1234/info');
  });

  test('never throws on network or JSON failures', async () => {
    globalThis.fetch = mockFetch(async () => { throw new Error('Network error'); });
    const networkResult = await discoverContextWindows('http://localhost:9999/v1');
    expect(networkResult.size).toBe(0);

    globalThis.fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Bad JSON'); },
    } as unknown as Response));
    const malformedResult = await discoverContextWindows('http://localhost:9999/v1');
    expect(malformedResult instanceof Map).toBe(true);
  });
});
