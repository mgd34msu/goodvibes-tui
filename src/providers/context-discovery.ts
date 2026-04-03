/**
 * context-discovery.ts
 *
 * G02: Multi-provider context window discovery with verbose-first endpoint probing.
 *
 * Implements a provider-agnostic discovery chain that probes endpoints from
 * most-informative (verbose) to least-informative, returning the richest
 * available context window data for each model.
 *
 * Discovery chain (ordered most-verbose to least-verbose):
 *   1. /api/v1/models  — LM Studio rich format (key + max_context_length)
 *   2. /api/tags       — Ollama list + per-model /api/show for context_length
 *   3. /v1/models      — OpenAI compat (id, optionally max_model_len for vLLM)
 *   4. /props          — llama.cpp server-level n_ctx (single context all models)
 *   5. /info           — TGI format (max_input_tokens / max_total_tokens)
 *
 * Feature flag: `local-provider-context-ingestion` (inherited from G00)
 */

import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout per individual probe request. */
const PROBE_TIMEOUT_MS = 5_000;

/** Placeholder model ID used when a server-level endpoint has no model list. */
export const SERVER_LEVEL_MODEL_ID = '__server__';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the origin (scheme + host + port) from a base URL string.
 * E.g. `http://192.168.0.85:1234/v1` → `http://192.168.0.85:1234`
 */
function extractOrigin(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    // Fallback: strip everything after the third slash component
    const match = baseURL.match(/^(https?:\/\/[^/]+)/);
    return match ? match[1] : baseURL;
  }
}

/**
 * Perform a timed fetch with optional Bearer auth.
 * Returns the Response on success, or null on any error (timeout, network, 4xx/5xx).
 */
async function probe(
  url: string,
  options: { apiKey?: string; method?: string; body?: string } = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;
    if (options.body) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.debug('[context-discovery] Non-OK probe response', { url, status: response.status });
      return null;
    }

    return response;
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'AbortError') {
      logger.debug('[context-discovery] Probe timed out', { url });
    } else {
      logger.debug('[context-discovery] Probe failed', { url, error: String(err) });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Safely parse JSON from a Response. Returns null on parse error.
 */
async function parseJSON<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Probe 1: LM Studio — /api/v1/models
// ---------------------------------------------------------------------------

interface LMStudioModel {
  key: string;
  max_context_length?: number;
  [k: string]: unknown;
}

interface LMStudioModelsResponse {
  models: LMStudioModel[];
}

/**
 * Probe `/api/v1/models` (LM Studio rich format).
 * Returns model_id → context_length map, or null if the endpoint is absent.
 */
async function probeLMStudio(
  origin: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const url = `${origin}/api/v1/models`;
  const response = await probe(url, { apiKey });
  if (!response) return null;

  const json = await parseJSON<LMStudioModelsResponse>(response);
  if (!Array.isArray(json?.models)) return null;

  const result = new Map<string, number>();
  for (const model of json.models) {
    if (typeof model.key !== 'string') continue;
    if (typeof model.max_context_length === 'number' && model.max_context_length > 0) {
      result.set(model.key, model.max_context_length);
    }
  }

  if (result.size > 0) {
    logger.debug('[context-discovery] LM Studio probe succeeded', { url, count: result.size });
    return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probe 2: Ollama — /api/tags + /api/show
// ---------------------------------------------------------------------------

interface OllamaTagModel {
  name: string;
  [k: string]: unknown;
}

interface OllamaTagsResponse {
  models: OllamaTagModel[];
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>;
  modelfile?: string;
  [k: string]: unknown;
}

/**
 * Extract context length from an Ollama `/api/show` response.
 * Tries `model_info.context_length`, then parses `num_ctx` from modelfile.
 */
function extractOllamaContextLength(show: OllamaShowResponse): number | null {
  // Prefer structured model_info
  if (show.model_info) {
    const ctx = show.model_info['context_length'];
    if (typeof ctx === 'number' && ctx > 0) return ctx;
    // Explicit key scan for context_length variants
    for (const [key, val] of Object.entries(show.model_info)) {
      if (/context[_.]?len/i.test(key) && typeof val === 'number' && val > 0) {
        return val;
      }
    }
  }

  // Fallback: parse num_ctx from modelfile
  if (typeof show.modelfile === 'string') {
    const match = show.modelfile.match(/^\s*PARAMETER\s+num_ctx\s+(\d+)/im);
    if (match) {
      const ctx = parseInt(match[1], 10);
      if (ctx > 0) return ctx;
    }
  }

  return null;
}

/**
 * Probe `/api/tags` (Ollama model list) then per-model `/api/show`.
 * Returns model_id → context_length map, or null if the endpoint is absent.
 */
async function probeOllama(
  origin: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const tagsUrl = `${origin}/api/tags`;
  const tagsResponse = await probe(tagsUrl, { apiKey });
  if (!tagsResponse) return null;

  const tagsJson = await parseJSON<OllamaTagsResponse>(tagsResponse);
  if (!Array.isArray(tagsJson?.models)) return null;

  const result = new Map<string, number>();

  // Fetch show data for each model in groups of SHOW_CONCURRENCY to bound parallelism.
  const SHOW_CONCURRENCY = 10;
  const names = tagsJson.models.filter((m) => typeof m.name === 'string').map((m) => m.name);

  for (let i = 0; i < names.length; i += SHOW_CONCURRENCY) {
    const batch = names.slice(i, i + SHOW_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (name) => {
        const showUrl = `${origin}/api/show`;
        const showResponse = await probe(showUrl, {
          apiKey,
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        if (!showResponse) return;

        const showJson = await parseJSON<OllamaShowResponse>(showResponse);
        if (!showJson) return;

        const ctx = extractOllamaContextLength(showJson);
        if (ctx !== null) {
          result.set(name, ctx);
        }
      }),
    );

    // Log any individual show failures at debug level only
    for (const r of batchResults) {
      if (r.status === 'rejected') {
        logger.debug('[context-discovery] Ollama /api/show error', { error: String(r.reason) });
      }
    }
  }

  if (result.size > 0) {
    logger.debug('[context-discovery] Ollama probe succeeded', { url: tagsUrl, count: result.size });
    return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probe 3: OpenAI compat — /v1/models
// ---------------------------------------------------------------------------

interface OpenAICompatModel {
  id: string;
  /** vLLM exposes this */
  max_model_len?: number;
  max_context_length?: number;
  context_length?: number;
  limits?: {
    max_context_length?: number;
    context_length?: number;
  };
  [k: string]: unknown;
}

interface OpenAICompatResponse {
  data: OpenAICompatModel[];
}

function extractOpenAIContextLength(model: OpenAICompatModel): number | null {
  if (typeof model.max_model_len === 'number' && model.max_model_len > 0) return model.max_model_len;
  if (typeof model.max_context_length === 'number' && model.max_context_length > 0) return model.max_context_length;
  if (typeof model.context_length === 'number' && model.context_length > 0) return model.context_length;
  if (model.limits) {
    if (typeof model.limits.max_context_length === 'number' && model.limits.max_context_length > 0) {
      return model.limits.max_context_length;
    }
    if (typeof model.limits.context_length === 'number' && model.limits.context_length > 0) {
      return model.limits.context_length;
    }
  }
  return null;
}

/**
 * Probe `/v1/models` (OpenAI-compatible endpoint).
 * Returns model_id → context_length map (may be empty if no context fields present),
 * or null if the endpoint is absent.
 */
async function probeOpenAICompat(
  baseURL: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const url = baseURL.replace(/\/$/, '') + '/models';
  const response = await probe(url, { apiKey });
  if (!response) return null;

  const json = await parseJSON<OpenAICompatResponse>(response);
  if (!Array.isArray(json?.data)) return null;

  const result = new Map<string, number>();
  for (const model of json.data) {
    if (typeof model.id !== 'string') continue;
    const ctx = extractOpenAIContextLength(model);
    if (ctx !== null) {
      result.set(model.id, ctx);
    }
  }

  // Return even if empty — the endpoint existing is meaningful
  logger.debug('[context-discovery] OpenAI compat probe completed', { url, count: result.size });
  return result;
}

// ---------------------------------------------------------------------------
// Probe 4: llama.cpp — /props
// ---------------------------------------------------------------------------

interface LlamaCppProps {
  n_ctx?: number;
  [k: string]: unknown;
}

/**
 * Probe `/props` (llama.cpp server-level context).
 * Returns a single-entry map keyed by SERVER_LEVEL_MODEL_ID, or null.
 */
async function probeLlamaCpp(
  origin: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const url = `${origin}/props`;
  const response = await probe(url, { apiKey });
  if (!response) return null;

  const json = await parseJSON<LlamaCppProps>(response);
  if (typeof json?.n_ctx !== 'number' || json.n_ctx <= 0) return null;

  logger.debug('[context-discovery] llama.cpp /props probe succeeded', { url, n_ctx: json.n_ctx });
  return new Map([[SERVER_LEVEL_MODEL_ID, json.n_ctx]]);
}

// ---------------------------------------------------------------------------
// Probe 5: TGI — /info
// ---------------------------------------------------------------------------

interface TGIInfo {
  max_input_tokens?: number;
  max_total_tokens?: number;
  [k: string]: unknown;
}

/**
 * Probe `/info` (TGI single-model server info).
 * Prefers max_total_tokens, falls back to max_input_tokens.
 * Returns a single-entry map keyed by SERVER_LEVEL_MODEL_ID, or null.
 */
async function probeTGI(
  origin: string,
  apiKey?: string,
): Promise<Map<string, number> | null> {
  const url = `${origin}/info`;
  const response = await probe(url, { apiKey });
  if (!response) return null;

  const json = await parseJSON<TGIInfo>(response);
  if (!json) return null;

  const ctx =
    (typeof json.max_total_tokens === 'number' && json.max_total_tokens > 0
      ? json.max_total_tokens
      : null) ??
    (typeof json.max_input_tokens === 'number' && json.max_input_tokens > 0
      ? json.max_input_tokens
      : null);

  if (ctx === null) return null;

  logger.debug('[context-discovery] TGI /info probe succeeded', { url, ctx });
  return new Map([[SERVER_LEVEL_MODEL_ID, ctx]]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover context window sizes for all models at the given provider base URL.
 *
 * Probes endpoints in verbose-first order:
 *   1. LM Studio `/api/v1/models`
 *   2. Ollama `/api/tags` + `/api/show`
 *   3. OpenAI-compat `/v1/models`
 *   4. llama.cpp `/props`
 *   5. TGI `/info`
 *
 * The first probe that yields a non-null result populates the map. Subsequent
 * probes only ADD entries for model IDs not yet present — they never overwrite
 * data from a more-informative probe.
 *
 * @param baseURL - Provider base URL (e.g. `http://localhost:11434/v1`).
 *   The `/v1` suffix is used for the OpenAI-compat probe; the origin is
 *   derived automatically for all other probes.
 * @param apiKey  - Optional Bearer token sent with every probe request.
 * @returns Map of model ID → context window in tokens. Empty map if all
 *          probes fail or none return context length data.
 */
export async function discoverContextWindows(
  baseURL: string,
  apiKey?: string,
): Promise<Map<string, number>> {
  const origin = extractOrigin(baseURL);
  const result = new Map<string, number>();

  /**
   * Merge entries from a probe result into the accumulator.
   * Only adds entries not already present (verbose-first wins).
   */
  function merge(probeResult: Map<string, number> | null): void {
    if (!probeResult) return;
    for (const [id, ctx] of probeResult) {
      if (!result.has(id)) {
        result.set(id, ctx);
      }
    }
  }

  // Probes run sequentially (not in parallel) because of verbose-first ordering:
  // each successful probe short-circuits by populating result, and merge() skips
  // model IDs already present. Parallel probing would lose this precedence guarantee.

  // Probe 1: LM Studio (richest — has max_context_length per model)
  merge(await probeLMStudio(origin, apiKey));

  // Probe 2: Ollama (per-model show with context_length / num_ctx)
  merge(await probeOllama(origin, apiKey));

  // Probe 3: OpenAI compat (id + optional max_model_len/max_context_length)
  merge(await probeOpenAICompat(baseURL, apiKey));

  // Probe 4: llama.cpp /props (server-level n_ctx)
  merge(await probeLlamaCpp(origin, apiKey));

  // Probe 5: TGI /info (server-level max_total_tokens)
  merge(await probeTGI(origin, apiKey));

  logger.debug('[context-discovery] Discovery complete', {
    baseURL,
    totalModels: result.size,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  probeLMStudio as _probeLMStudio,
  probeOllama as _probeOllama,
  probeOpenAICompat as _probeOpenAICompat,
  probeLlamaCpp as _probeLlamaCpp,
  probeTGI as _probeTGI,
  extractOrigin as _extractOrigin,
  extractOllamaContextLength as _extractOllamaContextLength,
  extractOpenAIContextLength as _extractOpenAIContextLength,
};
