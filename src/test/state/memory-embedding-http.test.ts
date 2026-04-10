import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createBuiltinMemoryEmbeddingProviders } from '../../state/memory-embedding-http.ts';
import type { MemoryEmbeddingProvider } from '../../state/index.ts';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_EMBEDDING_MODEL',
  'LM_STUDIO_BASE_URL',
  'LM_STUDIO_EMBEDDING_MODEL',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_EMBEDDING_MODEL',
  'MISTRAL_API_KEY',
  'MISTRAL_BASE_URL',
  'MISTRAL_EMBEDDING_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_EMBEDDING_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_EMBEDDING_MODEL',
] as const;

function requireAsyncEmbeddingProvider(provider: MemoryEmbeddingProvider | undefined): MemoryEmbeddingProvider & { embed: NonNullable<MemoryEmbeddingProvider['embed']> } {
  if (!provider?.embed) {
    throw new Error('Expected an async embedding provider');
  }
  return provider as MemoryEmbeddingProvider & { embed: NonNullable<MemoryEmbeddingProvider['embed']> };
}

describe('builtin memory embedding HTTP providers', () => {
  const snapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      snapshot.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = snapshot.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('reports provider diagnostics for builtins', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.test/v1';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';

    const providers = createBuiltinMemoryEmbeddingProviders();
    const statuses = await Promise.all(providers.map((provider) => provider.status?.()));
    const byId = new Map(statuses.filter(Boolean).map((status) => [status!.id, status!]));

    expect(byId.get('openai')?.configured).toBe(true);
    expect(byId.get('openai')?.metadata).toMatchObject({
      providerKind: 'openai',
      baseUrl: 'https://api.openai.test/v1',
      model: 'text-embedding-3-small',
    });
    expect(byId.get('openai-compatible')?.configured).toBe(true);
    expect(byId.get('gemini')?.configured).toBe(true);
    expect(byId.get('mistral')?.configured).toBe(true);
    expect(byId.get('ollama')?.configured).toBe(true);
  });

  test('adapts OpenAI-compatible and OpenAI JSON embedding responses', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        model: String(body.model ?? 'text-embedding-3-small'),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.test/v1';
    process.env.LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';
    process.env.LM_STUDIO_EMBEDDING_MODEL = 'nomic-embed-text';

    const providers = createBuiltinMemoryEmbeddingProviders({ fetchImpl });
    const openai = providers.find((provider) => provider.id === 'openai');
    const openaiCompatible = providers.find((provider) => provider.id === 'openai-compatible');
    expect(openai).toBeTruthy();
    expect(openaiCompatible).toBeTruthy();
    const openaiProvider = requireAsyncEmbeddingProvider(openai);
    const openaiCompatibleProvider = requireAsyncEmbeddingProvider(openaiCompatible);

    const openaiResult = await openaiProvider.embed({
      text: 'vector search',
      dimensions: 384,
      usage: 'query',
    });
    const compatibleResult = await openaiCompatibleProvider.embed({
      text: 'vector search',
      dimensions: 384,
      usage: 'query',
    });

    expect(openaiResult.vector.length).toBe(3);
    expect(compatibleResult.vector.length).toBe(3);
    expect(calls[0]?.url).toBe('https://api.openai.test/v1/embeddings');
    expect(calls[1]?.url).toBe('http://127.0.0.1:1234/v1/embeddings');
    expect(calls[0]?.body).toMatchObject({
      model: 'text-embedding-3-small',
      input: 'vector search',
      dimensions: 384,
    });
    expect(calls[1]?.body).toMatchObject({
      model: 'nomic-embed-text',
      input: 'vector search',
    });
  });

  test('adapts Gemini, Mistral, and Ollama embedding responses', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          embedding: { values: [0.4, 0.5, 0.6, 0.7] },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/embed')) {
        return new Response(JSON.stringify({
          embeddings: [[0.8, 0.9, 1.0]],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        data: [{ embedding: [0.11, 0.22, 0.33, 0.44] }],
        model: String(body.model ?? 'mistral-embed'),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.MISTRAL_API_KEY = 'mistral-key';
    process.env.MISTRAL_BASE_URL = 'https://api.mistral.test/v1';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

    const providers = createBuiltinMemoryEmbeddingProviders({ fetchImpl });
    const gemini = providers.find((provider) => provider.id === 'gemini');
    const mistral = providers.find((provider) => provider.id === 'mistral');
    const ollama = providers.find((provider) => provider.id === 'ollama');
    expect(gemini).toBeTruthy();
    expect(mistral).toBeTruthy();
    expect(ollama).toBeTruthy();
    const geminiProvider = requireAsyncEmbeddingProvider(gemini);
    const mistralProvider = requireAsyncEmbeddingProvider(mistral);
    const ollamaProvider = requireAsyncEmbeddingProvider(ollama);

    const geminiResult = await geminiProvider.embed({
      text: 'retrieval query',
      dimensions: 384,
      usage: 'query',
    });
    const mistralResult = await mistralProvider.embed({
      text: 'retrieval query',
      dimensions: 384,
      usage: 'record',
    });
    const ollamaResult = await ollamaProvider.embed({
      text: 'retrieval query',
      dimensions: 384,
      usage: 'record',
    });

    expect(geminiResult.vector.length).toBe(4);
    expect(mistralResult.vector.length).toBe(4);
    expect(ollamaResult.vector.length).toBe(3);
    expect(calls.some((call) => call.url.includes('gemini-embedding-001:embedContent'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/embeddings'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/api/embed'))).toBe(true);
  });
});
