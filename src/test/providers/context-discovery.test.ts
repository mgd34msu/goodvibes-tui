/**
 * Multi-provider context window discovery tests.
 *
 * Tests each probe path individually and the fallback chain behaviour.
 * All tests use globalThis.fetch mocking — no real network calls.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  discoverContextWindows,
  SERVER_LEVEL_MODEL_ID,
  _probeLMStudio,
  _probeOllama,
  _probeOpenAICompat,
  _probeLlamaCpp,
  _probeTGI,
  _extractOrigin,
  _extractOllamaContextLength,
  _extractOpenAIContextLength,
} from '@pellux/goodvibes-sdk/platform/providers/context-discovery';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// _extractOrigin
// ---------------------------------------------------------------------------

describe('_extractOrigin', () => {
  test('strips path from standard base URL', () => {
    expect(_extractOrigin('http://192.168.0.85:1234/v1')).toBe('http://192.168.0.85:1234');
  });

  test('handles no-path URL', () => {
    expect(_extractOrigin('http://localhost:11434')).toBe('http://localhost:11434');
  });

  test('handles deep path', () => {
    expect(_extractOrigin('http://example.com/api/v2/models')).toBe('http://example.com');
  });
});

// ---------------------------------------------------------------------------
// _extractOpenAIContextLength
// ---------------------------------------------------------------------------

describe('_extractOpenAIContextLength', () => {
  test('prefers max_model_len (vLLM)', () => {
    expect(_extractOpenAIContextLength({ id: 'm', max_model_len: 32768, max_context_length: 4096 })).toBe(32768);
  });

  test('falls back to max_context_length', () => {
    expect(_extractOpenAIContextLength({ id: 'm', max_context_length: 8192 })).toBe(8192);
  });

  test('falls back to context_length', () => {
    expect(_extractOpenAIContextLength({ id: 'm', context_length: 4096 })).toBe(4096);
  });

  test('falls back to limits.max_context_length', () => {
    expect(_extractOpenAIContextLength({ id: 'm', limits: { max_context_length: 16384 } })).toBe(16384);
  });

  test('returns null when no context field present', () => {
    expect(_extractOpenAIContextLength({ id: 'm' })).toBeNull();
  });

  test('ignores zero values', () => {
    expect(_extractOpenAIContextLength({ id: 'm', max_model_len: 0, max_context_length: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _extractOllamaContextLength
// ---------------------------------------------------------------------------

describe('_extractOllamaContextLength', () => {
  test('reads context_length from model_info', () => {
    expect(_extractOllamaContextLength({ model_info: { context_length: 131072 } })).toBe(131072);
  });

  test('reads num_ctx from modelfile PARAMETER directive', () => {
    expect(_extractOllamaContextLength({
      modelfile: 'FROM llama3\nPARAMETER num_ctx 8192\nPARAMETER temperature 0.7',
    })).toBe(8192);
  });

  test('prefers model_info over modelfile', () => {
    expect(_extractOllamaContextLength({
      model_info: { context_length: 32768 },
      modelfile: 'PARAMETER num_ctx 4096',
    })).toBe(32768);
  });

  test('returns null when neither field present', () => {
    expect(_extractOllamaContextLength({})).toBeNull();
  });

  test('falls through to modelfile when model_info context_length is 0', () => {
    expect(_extractOllamaContextLength({
      model_info: { context_length: 0 },
      modelfile: 'PARAMETER num_ctx 2048',
    })).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Probe 1: LM Studio — _probeLMStudio
// ---------------------------------------------------------------------------

describe('Probe 1: LM Studio /api/v1/models', () => {
  test('extracts key + max_context_length', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/models')) {
        return makeResponse({
          models: [
            { key: 'gemma-4-e4b-it@q8_k_xl', max_context_length: 131072 },
            { key: 'phi-3-mini', max_context_length: 4096 },
          ],
        });
      }
      return notFound();
    });

    const result = await _probeLMStudio('http://192.168.0.85:1234');
    expect(result).not.toBeNull();
    expect(result!.get('gemma-4-e4b-it@q8_k_xl')).toBe(131072);
    expect(result!.get('phi-3-mini')).toBe(4096);
  });

  test('returns null on 404', async () => {
    globalThis.fetch = mockFetch(async () => notFound());
    const result = await _probeLMStudio('http://localhost:1234');
    expect(result).toBeNull();
  });

  test('returns null when models array has no context lengths', async () => {
    globalThis.fetch = mockFetch(async () => makeResponse({ models: [{ key: 'model-a' }] }));
    const result = await _probeLMStudio('http://localhost:1234');
    expect(result).toBeNull();
  });

  test('skips models missing key field', async () => {
    globalThis.fetch = mockFetch(async () =>
      makeResponse({ models: [{ name: 'unnamed', max_context_length: 8192 }] }));
    const result = await _probeLMStudio('http://localhost:1234');
    expect(result).toBeNull();
  });

  test('sends Authorization header when apiKey provided', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mockFetch(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse({ models: [{ key: 'm', max_context_length: 4096 }] });
    });

    await _probeLMStudio('http://localhost:1234', 'test-key');
    expect(capturedHeaders?.['Authorization']).toBe('Bearer test-key');
  });
});

// ---------------------------------------------------------------------------
// Probe 2: Ollama — _probeOllama
// ---------------------------------------------------------------------------

describe('Probe 2: Ollama /api/tags + /api/show', () => {
  test('fetches tags then show with context_length from model_info', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return makeResponse({ models: [{ name: 'llama3:8b' }] });
      if (u.endsWith('/api/show')) return makeResponse({ model_info: { context_length: 8192 } });
      return notFound();
    });

    const result = await _probeOllama('http://localhost:11434');
    expect(result).not.toBeNull();
    expect(result!.get('llama3:8b')).toBe(8192);
  });

  test('extracts num_ctx from modelfile when model_info missing', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return makeResponse({ models: [{ name: 'phi3:mini' }] });
      if (u.endsWith('/api/show')) return makeResponse({ modelfile: 'FROM phi3\nPARAMETER num_ctx 4096' });
      return notFound();
    });

    const result = await _probeOllama('http://localhost:11434');
    expect(result!.get('phi3:mini')).toBe(4096);
  });

  test('returns null when /api/tags returns 404', async () => {
    globalThis.fetch = mockFetch(async () => notFound());
    const result = await _probeOllama('http://localhost:11434');
    expect(result).toBeNull();
  });

  test('sends correct model name in /api/show body', async () => {
    const showBodies: string[] = [];
    globalThis.fetch = mockFetch(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return makeResponse({ models: [{ name: 'mistral:7b' }] });
      if (u.endsWith('/api/show')) {
        showBodies.push(init?.body as string);
        return makeResponse({ model_info: { context_length: 32768 } });
      }
      return notFound();
    });

    await _probeOllama('http://localhost:11434');
    expect(showBodies.length).toBe(1);
    const body = JSON.parse(showBodies[0]);
    expect(body.name).toBe('mistral:7b');
  });

  test('handles /api/show failure gracefully for individual models', async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) {
        return makeResponse({ models: [{ name: 'good-model' }, { name: 'bad-model' }] });
      }
      if (u.endsWith('/api/show')) {
        callCount++;
        return callCount === 1
          ? makeResponse({ model_info: { context_length: 32768 } })
          : notFound();
      }
      return notFound();
    });

    // Should not throw; partial success is fine
    const result = await _probeOllama('http://localhost:11434');
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Probe 3: OpenAI compat — _probeOpenAICompat
// ---------------------------------------------------------------------------

describe('Probe 3: OpenAI compat /v1/models', () => {
  test('extracts max_model_len (vLLM)', async () => {
    globalThis.fetch = mockFetch(async () =>
      makeResponse({ data: [{ id: 'llama-3.1-8b', max_model_len: 131072 }] }));

    const result = await _probeOpenAICompat('http://localhost:8000/v1');
    expect(result!.get('llama-3.1-8b')).toBe(131072);
  });

  test('returns empty map when no context fields present (standard OpenAI compat)', async () => {
    globalThis.fetch = mockFetch(async () =>
      makeResponse({ data: [{ id: 'gemma-4-e4b-it@q8_k_xl', object: 'model', owned_by: 'organization_owner' }] }));

    const result = await _probeOpenAICompat('http://192.168.0.85:1234/v1');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  test('returns null on 404', async () => {
    globalThis.fetch = mockFetch(async () => notFound());
    const result = await _probeOpenAICompat('http://localhost:8000/v1');
    expect(result).toBeNull();
  });

  test('appends /models to baseURL correctly', async () => {
    let capturedUrl = '';
    globalThis.fetch = mockFetch(async (url) => {
      capturedUrl = String(url);
      return makeResponse({ data: [] });
    });

    await _probeOpenAICompat('http://localhost:11434/v1');
    expect(capturedUrl).toBe('http://localhost:11434/v1/models');
  });

  test('strips trailing slash before appending /models', async () => {
    let capturedUrl = '';
    globalThis.fetch = mockFetch(async (url) => {
      capturedUrl = String(url);
      return makeResponse({ data: [] });
    });

    await _probeOpenAICompat('http://localhost:11434/v1/');
    expect(capturedUrl).toBe('http://localhost:11434/v1/models');
  });
});

// ---------------------------------------------------------------------------
// Probe 4: llama.cpp — _probeLlamaCpp
// ---------------------------------------------------------------------------

describe('Probe 4: llama.cpp /props', () => {
  test('extracts n_ctx and keys by SERVER_LEVEL_MODEL_ID', async () => {
    globalThis.fetch = mockFetch(async () => makeResponse({ n_ctx: 8192 }));

    const result = await _probeLlamaCpp('http://localhost:8080');
    expect(result).not.toBeNull();
    expect(result!.get(SERVER_LEVEL_MODEL_ID)).toBe(8192);
  });

  test('returns null on 404', async () => {
    globalThis.fetch = mockFetch(async () => notFound());
    const result = await _probeLlamaCpp('http://localhost:8080');
    expect(result).toBeNull();
  });

  test('returns null when n_ctx is missing', async () => {
    globalThis.fetch = mockFetch(async () => makeResponse({ model: 'llama-3' }));
    const result = await _probeLlamaCpp('http://localhost:8080');
    expect(result).toBeNull();
  });

  test('returns null when n_ctx is 0', async () => {
    globalThis.fetch = mockFetch(async () => makeResponse({ n_ctx: 0 }));
    const result = await _probeLlamaCpp('http://localhost:8080');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Probe 5: TGI — _probeTGI
// ---------------------------------------------------------------------------

describe('Probe 5: TGI /info', () => {
  test('prefers max_total_tokens', async () => {
    globalThis.fetch = mockFetch(async () =>
      makeResponse({ max_total_tokens: 32768, max_input_tokens: 16384 }));

    const result = await _probeTGI('http://localhost:8080');
    expect(result!.get(SERVER_LEVEL_MODEL_ID)).toBe(32768);
  });

  test('falls back to max_input_tokens when max_total_tokens absent', async () => {
    globalThis.fetch = mockFetch(async () => makeResponse({ max_input_tokens: 16384 }));

    const result = await _probeTGI('http://localhost:8080');
    expect(result!.get(SERVER_LEVEL_MODEL_ID)).toBe(16384);
  });

  test('returns null on 404', async () => {
    globalThis.fetch = mockFetch(async () => notFound());
    const result = await _probeTGI('http://localhost:8080');
    expect(result).toBeNull();
  });

  test('returns null when neither field present', async () => {
    globalThis.fetch = mockFetch(async () => makeResponse({ model_id: 'gpt2' }));
    const result = await _probeTGI('http://localhost:8080');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverContextWindows — fallback chain
// ---------------------------------------------------------------------------

describe('discoverContextWindows — fallback chain', () => {
  test('LM Studio wins when /api/v1/models returns data (verbose-first)', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/models')) {
        return makeResponse({
          models: [{ key: 'gemma-4-e4b-it@q8_k_xl', max_context_length: 131072 }],
        });
      }
      // OpenAI compat would return a different value — must not overwrite
      if (u.endsWith('/v1/models')) {
        return makeResponse({ data: [{ id: 'gemma-4-e4b-it@q8_k_xl', max_model_len: 999 }] });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://192.168.0.85:1234/v1');
    // LM Studio value must win over the OpenAI compat value
    expect(result.get('gemma-4-e4b-it@q8_k_xl')).toBe(131072);
  });

  test('falls back to OpenAI compat when LM Studio and Ollama absent', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/models')) return notFound();
      if (u.includes('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) {
        return makeResponse({ data: [{ id: 'phi-3', max_model_len: 4096 }] });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:8000/v1');
    expect(result.get('phi-3')).toBe(4096);
  });

  test('falls back to llama.cpp /props when all model-list probes fail', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/models')) return notFound();
      if (u.includes('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) return notFound();
      if (u.endsWith('/props')) return makeResponse({ n_ctx: 16384 });
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:8080/v1');
    expect(result.get(SERVER_LEVEL_MODEL_ID)).toBe(16384);
  });

  test('falls back to TGI /info as last resort', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/models')) return notFound();
      if (u.includes('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) return notFound();
      if (u.endsWith('/props')) return notFound();
      if (u.endsWith('/info')) return makeResponse({ max_total_tokens: 8192 });
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:8080/v1');
    expect(result.get(SERVER_LEVEL_MODEL_ID)).toBe(8192);
  });

  test('returns empty map when all probes fail', async () => {
    globalThis.fetch = mockFetch(async () => notFound());
    const result = await discoverContextWindows('http://offline.local/v1');
    expect(result.size).toBe(0);
  });

  test('verbose-first: LM Studio data not overwritten by OpenAI compat data', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/models')) {
        return makeResponse({ models: [{ key: 'my-model', max_context_length: 200000 }] });
      }
      if (u.endsWith('/v1/models')) {
        return makeResponse({ data: [{ id: 'my-model', max_model_len: 4096 }] });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:1234/v1');
    expect(result.get('my-model')).toBe(200000);
  });

  test('merge: models from different probes accumulate without conflict', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/models')) {
        return makeResponse({ models: [{ key: 'model-a', max_context_length: 128000 }] });
      }
      if (u.includes('/api/tags')) return notFound();
      if (u.endsWith('/v1/models')) {
        return makeResponse({ data: [{ id: 'model-b', max_model_len: 32768 }] });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://localhost:1234/v1');
    expect(result.get('model-a')).toBe(128000);
    expect(result.get('model-b')).toBe(32768);
  });

  test('probes correct URLs derived from baseURL', async () => {
    const probedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (url) => {
      probedUrls.push(String(url));
      return notFound();
    });

    await discoverContextWindows('http://192.168.0.85:1234/v1');

    expect(probedUrls).toContain('http://192.168.0.85:1234/api/v1/models');
    expect(probedUrls).toContain('http://192.168.0.85:1234/api/tags');
    expect(probedUrls).toContain('http://192.168.0.85:1234/v1/models');
    expect(probedUrls).toContain('http://192.168.0.85:1234/props');
    expect(probedUrls).toContain('http://192.168.0.85:1234/info');
  });
});

// ---------------------------------------------------------------------------
// Real-world LM Studio scenario (from task specification)
// ---------------------------------------------------------------------------

describe('Real-world: LM Studio at 192.168.0.85:1234', () => {
  test('picks up max_context_length from /api/v1/models, not /v1/models (no context data there)', async () => {
    globalThis.fetch = mockFetch(async (url) => {
      const u = String(url);
      if (u === 'http://192.168.0.85:1234/api/v1/models') {
        return makeResponse({
          models: [{
            key: 'gemma-4-e4b-it@q8_k_xl',
            max_context_length: 131072,
            object: 'model',
            owned_by: 'organization_owner',
          }],
        });
      }
      if (u === 'http://192.168.0.85:1234/v1/models') {
        return makeResponse({
          data: [{
            id: 'gemma-4-e4b-it@q8_k_xl',
            object: 'model',
            owned_by: 'organization_owner',
          }],
        });
      }
      return notFound();
    });

    const result = await discoverContextWindows('http://192.168.0.85:1234/v1');
    expect(result.get('gemma-4-e4b-it@q8_k_xl')).toBe(131072);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe('discoverContextWindows — error resilience', () => {
  test('never throws even with network errors on all probes', async () => {
    globalThis.fetch = mockFetch(async () => { throw new Error('Network error'); });
    const result = await discoverContextWindows('http://localhost:9999/v1');
    expect(result instanceof Map).toBe(true);
    expect(result.size).toBe(0);
  });

  test('never throws on malformed JSON response', async () => {
    globalThis.fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Bad JSON'); },
    } as unknown as Response));
    const result = await discoverContextWindows('http://localhost:9999/v1');
    expect(result instanceof Map).toBe(true);
  });
});
