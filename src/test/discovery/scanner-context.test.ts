import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { fetchModelContextWindows } from '@pellux/goodvibes-sdk/platform/discovery';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function makeFetch(handler: (url: string) => { ok: boolean; body: unknown }): FetchMock {
  return async (url: string) => {
    const { ok, body } = handler(url);
    return {
      ok,
      json: async () => body,
    } as unknown as Response;
  };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

describe('fetchModelContextWindows - ollama', () => {
  test('returns context length from model_info (newer Ollama)', async () => {
    globalThis.fetch = makeFetch((url) => {
      if (url.includes('/api/show')) {
        return {
          ok: true,
          body: {
            model_info: { 'llama.context_length': 32768 },
          },
        };
      }
      return { ok: false, body: null };
    }) as unknown as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 11434, 'ollama', ['llama3:8b']);
    expect(result['llama3:8b']).toBe(32768);
  });

  test('falls back to num_ctx in parameters string', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: {
        parameters: 'stop "<|im_end|>"\nnum_ctx 8192\ntemperature 0.7',
      },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 11434, 'ollama', ['mistral:7b']);
    expect(result['mistral:7b']).toBe(8192);
  });

  test('returns empty record when response is missing context info', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { details: {} },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 11434, 'ollama', ['phi3:mini']);
    expect(result).toEqual({});
  });

  test('returns empty record when all model fetches fail', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 11434, 'ollama', ['llama3:8b', 'mistral:7b']);
    expect(result).toEqual({});
  });

  test('handles multiple models in parallel, each writing to their own key', async () => {
    globalThis.fetch = makeFetch((url) => {
      const body = url.includes('/api/show') ? { model_info: { 'llama.context_length': 4096 } } : {};
      return { ok: true, body };
    }) as typeof globalThis.fetch;

    const models = ['model-a', 'model-b', 'model-c'];
    const result = await fetchModelContextWindows('127.0.0.1', 11434, 'ollama', models);
    for (const m of models) {
      expect(result[m]).toBe(4096);
    }
  });

  test('skips model when response is not ok', async () => {
    globalThis.fetch = makeFetch(() => ({ ok: false, body: null })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 11434, 'ollama', ['llama3:8b']);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// vLLM
// ---------------------------------------------------------------------------

describe('fetchModelContextWindows - vllm', () => {
  test('returns max_model_len for each model', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { id: 'mistralai/Mistral-7B', max_model_len: 16384 },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8000, 'vllm', ['mistralai/Mistral-7B']);
    expect(result['mistralai/Mistral-7B']).toBe(16384);
  });

  test('returns empty record when response is not ok', async () => {
    globalThis.fetch = makeFetch(() => ({ ok: false, body: null })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8000, 'vllm', ['some-model']);
    expect(result).toEqual({});
  });

  test('returns empty record on network failure', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('network error'))) as unknown as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8000, 'vllm', ['some-model']);
    expect(result).toEqual({});
  });

  test('skips model when max_model_len is zero or missing', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { id: 'some-model', max_model_len: 0 },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8000, 'vllm', ['some-model']);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// llama.cpp
// ---------------------------------------------------------------------------

describe('fetchModelContextWindows - llamacpp', () => {
  test('returns n_ctx from /props for all models', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { default_generation_settings: { n_ctx: 2048 } },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8080, 'llamacpp', ['model-a', 'model-b']);
    expect(result['model-a']).toBe(2048);
    expect(result['model-b']).toBe(2048);
  });

  test('returns empty record when /props fails', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('timeout'))) as unknown as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8080, 'llamacpp', ['model-a']);
    expect(result).toEqual({});
  });

  test('returns empty record when n_ctx is missing', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { default_generation_settings: {} },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8080, 'llamacpp', ['model-a']);
    expect(result).toEqual({});
  });

  test('returns empty record when /props returns not ok', async () => {
    globalThis.fetch = makeFetch(() => ({ ok: false, body: null })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 8080, 'llamacpp', ['model-a']);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Generic / unknown
// ---------------------------------------------------------------------------

describe('fetchModelContextWindows - generic (unknown/lm-studio/etc)', () => {
  test('returns max_model_len when present', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { id: 'gpt-3.5-turbo', max_model_len: 4096 },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', ['gpt-3.5-turbo']);
    expect(result['gpt-3.5-turbo']).toBe(4096);
  });

  test('falls back to context_length', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { context_length: 8192 },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', ['my-model']);
    expect(result['my-model']).toBe(8192);
  });

  test('falls back to context_window', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { context_window: 16000 },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', ['my-model']);
    expect(result['my-model']).toBe(16000);
  });

  test('falls back to max_context_length', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { max_context_length: 2048 },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', ['my-model']);
    expect(result['my-model']).toBe(2048);
  });

  test('returns empty record when no context field is present', async () => {
    globalThis.fetch = makeFetch(() => ({
      ok: true,
      body: { id: 'some-model' },
    })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', ['some-model']);
    expect(result).toEqual({});
  });

  test('returns empty record on network failure', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('timeout'))) as unknown as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', ['some-model']);
    expect(result).toEqual({});
  });

  test('lm-studio: returns correct context windows from /api/v1/models rich endpoint', async () => {
    // LM Studio exposes /api/v1/models with max_context_length per model.
    // fetchModelContextWindows should delegate to discoverContextWindows which
    // probes that endpoint first (verbose-first), returning accurate values.
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { key: 'meta-llama-3.1-8b-instruct', max_context_length: 131072 },
              { key: 'qwen2.5-coder-7b-instruct', max_context_length: 32768 },
            ],
          }),
        } as unknown as Response;
      }
      // No other endpoints needed — the rich probe succeeds
      return { ok: false, json: async () => null } as unknown as Response;
    }) as typeof globalThis.fetch;

    const models = ['meta-llama-3.1-8b-instruct', 'qwen2.5-coder-7b-instruct'];
    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'lm-studio', models);
    expect(result['meta-llama-3.1-8b-instruct']).toBe(131072);
    expect(result['qwen2.5-coder-7b-instruct']).toBe(32768);
  });

  test('lm-studio: does NOT default to 8192 when rich endpoint succeeds', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/v1/models')) {
        return {
          ok: true,
          json: async () => ({
            models: [{ key: 'my-model', max_context_length: 131072 }],
          }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => null } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'lm-studio', ['my-model']);
    expect(result['my-model']).toBe(131072);
    expect(result['my-model']).not.toBe(8192);
  });

  test('lm-studio: falls back to generic /v1/models/{id} probe when /api/v1/models returns empty', async () => {
    // If LM Studio rich endpoint returns no models (or 404), fall through to generic probe
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/api/v1/models')) {
        // Responds but with empty models list
        return { ok: true, json: async () => ({ models: [] }) } as unknown as Response;
      }
      if (url.includes('/api/tags')) {
        return { ok: false, json: async () => null } as unknown as Response;
      }
      if (url.includes('/v1/models/')) {
        return {
          ok: true,
          json: async () => ({ id: 'fallback-model', context_length: 16384 }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => null } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'lm-studio', ['fallback-model']);
    expect(result['fallback-model']).toBe(16384);
  });

  test('returns empty record when empty models array is passed', async () => {
    globalThis.fetch = makeFetch(() => ({ ok: true, body: {} })) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('127.0.0.1', 1234, 'unknown', []);
    expect(result).toEqual({});
  });

  test('falls back to /props when /v1/models/{id} returns no context info', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/v1/models/')) {
        return { ok: true, json: async () => ({ id: 'my-model', object: 'model' }) } as unknown as Response;
      }
      if (url.includes('/props')) {
        return { ok: true, json: async () => ({ default_generation_settings: { n_ctx: 32768 } }) } as unknown as Response;
      }
      return { ok: false, json: async () => null } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('192.168.0.85', 8001, 'unknown', ['my-model']);
    expect(result['my-model']).toBe(32768);
  });

  test('does not try /props fallback when /v1/models/{id} already returned a context window', async () => {
    let propsCalled = false;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/props')) {
        propsCalled = true;
        return { ok: true, json: async () => ({ default_generation_settings: { n_ctx: 99999 } }) } as unknown as Response;
      }
      // /v1/models/{id} returns a valid context window
      return { ok: true, json: async () => ({ id: 'my-model', context_length: 16384 }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await fetchModelContextWindows('192.168.0.85', 8001, 'unknown', ['my-model']);
    expect(result['my-model']).toBe(16384);
    expect(propsCalled).toBe(false);
  });
});
