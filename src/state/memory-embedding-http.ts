import { DEFAULT_MEMORY_EMBEDDING_DIMS } from './memory-embeddings.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderState,
  MemoryEmbeddingProviderStatus,
  MemoryEmbeddingRequest,
  MemoryEmbeddingResult,
} from './memory-embeddings.ts';

type EnvMap = Record<string, string | undefined>;

interface ProviderRuntimeConfig {
  readonly baseUrl: string;
  readonly baseUrlSource: string;
  readonly model: string;
  readonly modelSource: string;
  readonly apiKey?: string;
  readonly apiKeySource?: string;
  readonly endpoint: string;
  readonly authMode: 'none' | 'bearer' | 'x-goog-api-key';
  readonly requestedDimensions: number;
  readonly configured: boolean;
  readonly state: MemoryEmbeddingProviderState;
  readonly detail: string;
  readonly metadata: Record<string, unknown>;
}

interface ProviderDefinition {
  readonly id: string;
  readonly label: string;
  readonly local: boolean;
  resolveConfig(env: EnvMap, requestedDimensions: number): ProviderRuntimeConfig;
  buildRequest(config: ProviderRuntimeConfig, request: MemoryEmbeddingRequest): RequestInit & { readonly url: string };
  parseResponse(payload: unknown, request: MemoryEmbeddingRequest, config: ProviderRuntimeConfig): MemoryEmbeddingResult;
}

interface CreateProviderContext {
  readonly env?: EnvMap;
  readonly fetchImpl?: EmbeddingFetchLike;
}

type EmbeddingFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';
const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'embeddinggemma';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-embedding-001';
const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
const DEFAULT_MISTRAL_MODEL = 'mistral-embed';

export function createBuiltinMemoryEmbeddingProviders(context: CreateProviderContext = {}): MemoryEmbeddingProvider[] {
  return [
    createHttpEmbeddingProvider(createOpenAIEmbeddingDefinition(), context),
    createHttpEmbeddingProvider(createOpenAICompatibleEmbeddingDefinition(), context),
    createHttpEmbeddingProvider(createGeminiEmbeddingDefinition(), context),
    createHttpEmbeddingProvider(createMistralEmbeddingDefinition(), context),
    createHttpEmbeddingProvider(createOllamaEmbeddingDefinition(), context),
  ];
}

function createHttpEmbeddingProvider(definition: ProviderDefinition, context: CreateProviderContext): MemoryEmbeddingProvider {
  const env = context.env ?? process.env;
  const fetchImpl: EmbeddingFetchLike = context.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    id: definition.id,
    label: definition.label,
    dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
    local: definition.local,
    async embed(request: MemoryEmbeddingRequest): Promise<MemoryEmbeddingResult> {
      const config = definition.resolveConfig(env, request.dimensions);
      if (!config.configured) {
        throw new Error(config.detail);
      }
      const response = await fetchImpl(config.endpoint, definition.buildRequest(config, request));
      const payload = await readJsonResponse(response, config.endpoint, definition.id);
      const result = definition.parseResponse(payload, request, config);
      return {
        vector: result.vector,
        dimensions: result.dimensions,
        modelId: result.modelId ?? config.model,
        metadata: {
          ...config.metadata,
          ...result.metadata,
          providerId: definition.id,
          providerLabel: definition.label,
        },
      };
    },
    async status(): Promise<MemoryEmbeddingProviderStatus> {
      const config = definition.resolveConfig(env, DEFAULT_MEMORY_EMBEDDING_DIMS);
      return {
        id: definition.id,
        label: definition.label,
        state: config.state,
        dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
        configured: config.configured,
        deterministic: false,
        detail: config.detail,
        metadata: {
          ...config.metadata,
          local: definition.local,
          hasSyncEmbed: false,
          hasAsyncEmbed: true,
        },
      };
    },
  };
}

function createOpenAIEmbeddingDefinition(): ProviderDefinition {
  return {
    id: 'openai',
    label: 'OpenAI Embeddings',
    local: false,
    resolveConfig(env, requestedDimensions) {
      const baseUrl = pickEnv(env, ['OPENAI_BASE_URL', 'OPENAI_API_BASE'], DEFAULT_OPENAI_BASE_URL);
      const model = pickEnv(env, ['OPENAI_EMBEDDING_MODEL'], DEFAULT_OPENAI_MODEL);
      const apiKey = pickEnv(env, ['OPENAI_API_KEY', 'OPENAI_KEY'], '');
      const configured = Boolean(apiKey.value);
      const state: MemoryEmbeddingProviderState = configured ? 'healthy' : 'degraded';
      return {
        baseUrl: baseUrl.value,
        baseUrlSource: baseUrl.source,
        model: model.value,
        modelSource: model.source,
        apiKey: apiKey.value || undefined,
        apiKeySource: apiKey.source || undefined,
        endpoint: joinUrl(baseUrl.value, 'embeddings'),
        authMode: 'bearer',
        requestedDimensions,
        configured,
        state,
        detail: configured
          ? `POST ${joinUrl(baseUrl.value, 'embeddings')} with model ${model.value}`
          : `Set OPENAI_API_KEY to enable the OpenAI embeddings provider (${joinUrl(baseUrl.value, 'embeddings')}).`,
        metadata: {
          providerKind: 'openai',
          baseUrl: baseUrl.value,
          baseUrlSource: baseUrl.source,
          model: model.value,
          modelSource: model.source,
          apiKeyConfigured: Boolean(apiKey.value),
          apiKeySource: apiKey.source || null,
          authMode: 'bearer',
          endpoint: joinUrl(baseUrl.value, 'embeddings'),
          supportsDimensionsParam: true,
          requestedDimensions,
        },
      };
    },
    buildRequest(config, request) {
      return {
        url: config.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${config.apiKey ?? ''}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: request.text,
          dimensions: request.dimensions,
          encoding_format: 'float',
        }),
      };
    },
    parseResponse(payload, request, config) {
      const vector = extractEmbeddingVector(payload);
      if (!vector) {
        throw new Error(`OpenAI embeddings response from ${config.endpoint} did not include a vector`);
      }
      return {
        vector,
        dimensions: vector.length || request.dimensions,
        modelId: extractModelId(payload) ?? config.model,
        metadata: {
          providerKind: 'openai',
          endpoint: config.endpoint,
          model: config.model,
          requestedDimensions: request.dimensions,
          responseDimensions: vector.length,
        },
      };
    },
  };
}

function createOpenAICompatibleEmbeddingDefinition(): ProviderDefinition {
  return {
    id: 'openai-compatible',
    label: 'OpenAI-Compatible / LM Studio Embeddings',
    local: true,
    resolveConfig(env, requestedDimensions) {
      const baseUrl = pickEnv(
        env,
        ['LM_STUDIO_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPAT_BASE_URL'],
        DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      );
      const model = pickEnv(
        env,
        ['LM_STUDIO_EMBEDDING_MODEL', 'OPENAI_COMPATIBLE_EMBEDDING_MODEL', 'OPENAI_COMPAT_EMBEDDING_MODEL'],
        DEFAULT_OPENAI_COMPATIBLE_MODEL,
      );
      const apiKey = pickEnv(
        env,
        ['LM_STUDIO_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPAT_API_KEY'],
        '',
      );
      const endpoint = joinUrl(baseUrl.value, 'embeddings');
      const configured = Boolean(baseUrl.value && model.value);
      const state: MemoryEmbeddingProviderState = configured ? 'healthy' : 'unconfigured';
      return {
        baseUrl: baseUrl.value,
        baseUrlSource: baseUrl.source,
        model: model.value,
        modelSource: model.source,
        apiKey: apiKey.value || undefined,
        apiKeySource: apiKey.source || undefined,
        endpoint,
        authMode: 'bearer',
        requestedDimensions,
        configured,
        state,
        detail: configured
          ? `POST ${endpoint} with model ${model.value}`
          : 'Set LM_STUDIO_BASE_URL or OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_EMBEDDING_MODEL to enable OpenAI-compatible embeddings.',
        metadata: {
          providerKind: 'openai-compatible',
          baseUrl: baseUrl.value,
          baseUrlSource: baseUrl.source,
          model: model.value,
          modelSource: model.source,
          apiKeyConfigured: Boolean(apiKey.value),
          apiKeySource: apiKey.source || null,
          authMode: apiKey.value ? 'bearer' : 'none',
          endpoint,
          supportsDimensionsParam: false,
          requestedDimensions,
        },
      };
    },
    buildRequest(config, request) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }
      return {
        url: config.endpoint,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          input: request.text,
          encoding_format: 'float',
        }),
      };
    },
    parseResponse(payload, request, config) {
      const vector = extractEmbeddingVector(payload);
      if (!vector) {
        throw new Error(`OpenAI-compatible embeddings response from ${config.endpoint} did not include a vector`);
      }
      return {
        vector,
        dimensions: vector.length || request.dimensions,
        modelId: extractModelId(payload) ?? config.model,
        metadata: {
          providerKind: 'openai-compatible',
          endpoint: config.endpoint,
          model: config.model,
          requestedDimensions: request.dimensions,
          responseDimensions: vector.length,
        },
      };
    },
  };
}

function createGeminiEmbeddingDefinition(): ProviderDefinition {
  return {
    id: 'gemini',
    label: 'Gemini Embeddings',
    local: false,
    resolveConfig(env, requestedDimensions) {
      const baseUrl = pickEnv(env, ['GEMINI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'], DEFAULT_GEMINI_BASE_URL);
      const model = pickEnv(env, ['GEMINI_EMBEDDING_MODEL', 'GEMINI_MODEL'], DEFAULT_GEMINI_MODEL);
      const apiKey = pickEnv(env, ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], '');
      const endpoint = joinUrl(baseUrl.value, `models/${encodeURIComponent(model.value)}:embedContent`);
      const configured = Boolean(apiKey.value);
      const state: MemoryEmbeddingProviderState = configured ? 'healthy' : 'degraded';
      return {
        baseUrl: baseUrl.value,
        baseUrlSource: baseUrl.source,
        model: model.value,
        modelSource: model.source,
        apiKey: apiKey.value || undefined,
        apiKeySource: apiKey.source || undefined,
        endpoint,
        authMode: 'x-goog-api-key',
        requestedDimensions,
        configured,
        state,
        detail: configured
          ? `POST ${endpoint} with model ${model.value}`
          : `Set GEMINI_API_KEY to enable Gemini embeddings (${endpoint}).`,
        metadata: {
          providerKind: 'gemini',
          baseUrl: baseUrl.value,
          baseUrlSource: baseUrl.source,
          model: model.value,
          modelSource: model.source,
          apiKeyConfigured: Boolean(apiKey.value),
          apiKeySource: apiKey.source || null,
          authMode: 'x-goog-api-key',
          endpoint,
          supportsDimensionsParam: true,
          requestedDimensions,
        },
      };
    },
    buildRequest(config, request) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (config.apiKey) {
        headers['x-goog-api-key'] = config.apiKey;
      }
      return {
        url: config.endpoint,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: `models/${config.model}`,
          content: {
            parts: [{ text: request.text }],
          },
          taskType: request.usage === 'query'
            ? 'RETRIEVAL_QUERY'
            : request.usage === 'record'
              ? 'RETRIEVAL_DOCUMENT'
              : undefined,
          outputDimensionality: request.dimensions,
        }),
      };
    },
    parseResponse(payload, request, config) {
      const vector = extractEmbeddingVector(payload);
      if (!vector) {
        throw new Error(`Gemini embeddings response from ${config.endpoint} did not include a vector`);
      }
      return {
        vector,
        dimensions: vector.length || request.dimensions,
        modelId: extractModelId(payload) ?? config.model,
        metadata: {
          providerKind: 'gemini',
          endpoint: config.endpoint,
          model: config.model,
          requestedDimensions: request.dimensions,
          responseDimensions: vector.length,
        },
      };
    },
  };
}

function createMistralEmbeddingDefinition(): ProviderDefinition {
  return {
    id: 'mistral',
    label: 'Mistral Embeddings',
    local: false,
    resolveConfig(env, requestedDimensions) {
      const baseUrl = pickEnv(env, ['MISTRAL_BASE_URL'], DEFAULT_MISTRAL_BASE_URL);
      const model = pickEnv(env, ['MISTRAL_EMBEDDING_MODEL', 'MISTRAL_MODEL'], DEFAULT_MISTRAL_MODEL);
      const apiKey = pickEnv(env, ['MISTRAL_API_KEY'], '');
      const endpoint = joinUrl(baseUrl.value, 'embeddings');
      const configured = Boolean(apiKey.value);
      const state: MemoryEmbeddingProviderState = configured ? 'healthy' : 'degraded';
      return {
        baseUrl: baseUrl.value,
        baseUrlSource: baseUrl.source,
        model: model.value,
        modelSource: model.source,
        apiKey: apiKey.value || undefined,
        apiKeySource: apiKey.source || undefined,
        endpoint,
        authMode: 'bearer',
        requestedDimensions,
        configured,
        state,
        detail: configured
          ? `POST ${endpoint} with model ${model.value}`
          : `Set MISTRAL_API_KEY to enable Mistral embeddings (${endpoint}).`,
        metadata: {
          providerKind: 'mistral',
          baseUrl: baseUrl.value,
          baseUrlSource: baseUrl.source,
          model: model.value,
          modelSource: model.source,
          apiKeyConfigured: Boolean(apiKey.value),
          apiKeySource: apiKey.source || null,
          authMode: 'bearer',
          endpoint,
          supportsDimensionsParam: false,
          requestedDimensions,
        },
      };
    },
    buildRequest(config, request) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey ?? ''}`,
      };
      return {
        url: config.endpoint,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          input: request.text,
          encoding_format: 'float',
        }),
      };
    },
    parseResponse(payload, request, config) {
      const vector = extractEmbeddingVector(payload);
      if (!vector) {
        throw new Error(`Mistral embeddings response from ${config.endpoint} did not include a vector`);
      }
      return {
        vector,
        dimensions: vector.length || request.dimensions,
        modelId: extractModelId(payload) ?? config.model,
        metadata: {
          providerKind: 'mistral',
          endpoint: config.endpoint,
          model: config.model,
          requestedDimensions: request.dimensions,
          responseDimensions: vector.length,
        },
      };
    },
  };
}

function createOllamaEmbeddingDefinition(): ProviderDefinition {
  return {
    id: 'ollama',
    label: 'Ollama Embeddings',
    local: true,
    resolveConfig(env, requestedDimensions) {
      const baseUrl = pickEnv(env, ['OLLAMA_BASE_URL', 'OLLAMA_HOST'], DEFAULT_OLLAMA_BASE_URL);
      const model = pickEnv(env, ['OLLAMA_EMBEDDING_MODEL', 'OLLAMA_MODEL'], DEFAULT_OLLAMA_MODEL);
      const endpoint = joinUrl(baseUrl.value, 'api/embed');
      const configured = Boolean(baseUrl.value && model.value);
      const state: MemoryEmbeddingProviderState = configured ? 'healthy' : 'unconfigured';
      return {
        baseUrl: baseUrl.value,
        baseUrlSource: baseUrl.source,
        model: model.value,
        modelSource: model.source,
        endpoint,
        authMode: 'none',
        requestedDimensions,
        configured,
        state,
        detail: configured
          ? `POST ${endpoint} with model ${model.value}`
          : `Set OLLAMA_BASE_URL and OLLAMA_EMBEDDING_MODEL to enable Ollama embeddings.`,
        metadata: {
          providerKind: 'ollama',
          baseUrl: baseUrl.value,
          baseUrlSource: baseUrl.source,
          model: model.value,
          modelSource: model.source,
          authMode: 'none',
          endpoint,
          supportsDimensionsParam: false,
          requestedDimensions,
        },
      };
    },
    buildRequest(config, request) {
      return {
        url: config.endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          input: request.text,
        }),
      };
    },
    parseResponse(payload, request, config) {
      const vector = extractEmbeddingVector(payload);
      if (!vector) {
        throw new Error(`Ollama embeddings response from ${config.endpoint} did not include a vector`);
      }
      return {
        vector,
        dimensions: vector.length || request.dimensions,
        modelId: extractModelId(payload) ?? config.model,
        metadata: {
          providerKind: 'ollama',
          endpoint: config.endpoint,
          model: config.model,
          requestedDimensions: request.dimensions,
          responseDimensions: vector.length,
        },
      };
    },
  };
}

function pickEnv(env: EnvMap, keys: readonly string[], fallback: string): { readonly value: string; readonly source: string } {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { value, source: key };
  }
  return { value: fallback, source: 'default' };
}

function joinUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const tail = suffix.trim().replace(/^\/+/, '');
  return `${base}/${tail}`;
}

async function readJsonResponse(response: Response, endpoint: string, providerId: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const excerpt = text.slice(0, 500).trim();
    throw new Error(`${providerId} embeddings request to ${endpoint} failed with ${response.status} ${response.statusText}${excerpt ? `: ${excerpt}` : ''}`);
  }

  if (!text.trim()) {
    throw new Error(`${providerId} embeddings request to ${endpoint} returned an empty response`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${providerId} embeddings request to ${endpoint} returned invalid JSON: ${summarizeError(error)}`);
  }
}

function extractEmbeddingVector(payload: unknown): number[] | null {
  if (Array.isArray(payload)) {
    const direct = findNumericArray(payload);
    if (direct) return direct;
    for (const entry of payload) {
      const embedded = extractEmbeddingVector(entry);
      if (embedded) return embedded;
    }
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const direct = findNumericArray(record.embedding);
  if (direct) return direct;
  if (record.embedding && typeof record.embedding === 'object') {
    const nestedEmbedding = extractEmbeddingVector(record.embedding);
    if (nestedEmbedding) return nestedEmbedding;
  }

  const values = findNumericArray(record.values);
  if (values) return values;
  if (record.values && typeof record.values === 'object') {
    const nestedValues = extractEmbeddingVector(record.values);
    if (nestedValues) return nestedValues;
  }

  const vector = findNumericArray(record.vector);
  if (vector) return vector;
  if (record.vector && typeof record.vector === 'object') {
    const nestedVector = extractEmbeddingVector(record.vector);
    if (nestedVector) return nestedVector;
  }

  const data = record.data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const embedded = extractEmbeddingVector(entry);
      if (embedded) return embedded;
    }
  }

  const embeddings = record.embeddings;
  if (Array.isArray(embeddings)) {
    for (const entry of embeddings) {
      const embedded = extractEmbeddingVector(entry);
      if (embedded) return embedded;
    }
  }
  if (record.embeddings && typeof record.embeddings === 'object') {
    const nestedEmbeddings = extractEmbeddingVector(record.embeddings);
    if (nestedEmbeddings) return nestedEmbeddings;
  }

  const nested = record.result ?? record.embeddingResult ?? record.output;
  if (nested && typeof nested === 'object') {
    const embedded = extractEmbeddingVector(nested);
    if (embedded) return embedded;
  }

  return null;
}

function findNumericArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.every((item) => typeof item === 'number')) {
    return value.map((item) => Number(item));
  }
  if (value.every((item) => typeof item === 'string' && item.trim().length > 0 && Number.isFinite(Number(item)))) {
    return value.map((item) => Number(item));
  }
  return null;
}

function extractModelId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.model === 'string' && record.model.trim()) return record.model;
  if (typeof record.modelId === 'string' && record.modelId.trim()) return record.modelId;
  if (typeof record.model_name === 'string' && record.model_name.trim()) return record.model_name;
  return undefined;
}
