import { sleepWithSignal } from './backoff.ts';
import { mergeHeaders, resolveAuthToken, resolveHeaders, type AuthTokenResolver, type HeaderResolver } from './http-auth.ts';
import {
  getHttpRetryDelay,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  resolveHttpRetryPolicy,
  type HttpRetryPolicy,
} from './http-retry.ts';
import { buildUrl, createTransportPaths, type TransportPaths } from './transport-paths.ts';

export type { HttpRetryPolicy } from './http-retry.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export interface HttpJsonTransportOptions {
  readonly baseUrl: string;
  readonly authToken?: string | null;
  readonly getAuthToken?: AuthTokenResolver;
  readonly fetch?: typeof fetch;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: HeadersInit;
  readonly getHeaders?: HeaderResolver;
  readonly retry?: HttpRetryPolicy;
}

export interface HttpJsonRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  readonly retry?: false | HttpRetryPolicy;
}

export interface ResolvedContractRequest {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
}

export interface TransportJsonError {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;
  readonly method: string;
}

export interface HttpJsonTransport {
  readonly baseUrl: string;
  readonly authToken?: string | null;
  readonly fetchImpl: typeof fetch;
  readonly paths: TransportPaths;
  buildUrl(path: string): string;
  getAuthToken(): Promise<string | null>;
  requestJson<T>(pathOrUrl: string, options?: HttpJsonRequestOptions): Promise<T>;
  resolveContractRequest(method: string, path: string, input?: Record<string, unknown>): ResolvedContractRequest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function applyHeaderSource(
  target: Record<string, string>,
  source: HeadersInit | undefined,
): void {
  if (!source) return;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      target[key] = value;
    });
    return;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) {
      target[key] = value;
    }
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

function mergeHeaderRecord(...sources: Array<HeadersInit | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    applyHeaderSource(merged, source);
  }
  return merged;
}

function readErrorMessage(status: number, url: string, body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string' && body.error.trim()) {
    return body.error.trim();
  }
  if (typeof body === 'string' && body.trim()) {
    return body.trim();
  }
  return `Transport request failed with status ${status} for ${url}`;
}

function createTransportError(
  status: number,
  url: string,
  method: string,
  body: unknown,
): Error & { readonly transport: TransportJsonError } {
  return Object.assign(new Error(readErrorMessage(status, url, body)), {
    transport: {
      status,
      body,
      url,
      method,
    },
  });
}

function createNetworkTransportError(
  error: unknown,
  url: string,
  method: string,
): Error & { readonly transport: TransportJsonError } {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : `Transport request failed before receiving a response for ${url}`;
  return Object.assign(new Error(message), {
    cause: error,
    transport: {
      status: 0,
      body: { error: message },
      url,
      method,
    },
  });
}

function toStringValue(value: unknown, key: string): string {
  if (value === undefined || value === null) {
    throw new Error(`Missing required path parameter "${key}"`);
  }
  return String(value);
}

function addQueryValue(url: URL, key: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null) {
    url.searchParams.append(key, 'null');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      addQueryValue(url, key, item);
    }
    return;
  }
  if (typeof value === 'object') {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }
  url.searchParams.append(key, String(value));
}

function splitContractInput(path: string, input: Record<string, unknown> = {}): {
  readonly interpolatedPath: string;
  readonly remaining: Record<string, unknown>;
} {
  const remaining = { ...input };
  const interpolatedPath = path.replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = toStringValue(remaining[key], key);
    delete remaining[key];
    return encodeURIComponent(value);
  });
  return { interpolatedPath, remaining };
}

export function createJsonRequestInit(
  token: string | null | undefined,
  body?: unknown,
  method = 'GET',
  headers: HeadersInit = {},
  signal?: AbortSignal,
  defaultHeaders: HeadersInit = {},
): RequestInit {
  return {
    method,
    credentials: 'include',
    signal,
    headers: mergeHeaderRecord(
      defaultHeaders,
      token ? { Authorization: `Bearer ${token}` } : undefined,
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      headers,
    ),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export const createJsonInit = createJsonRequestInit;

export function createFetch(fetchImpl?: typeof fetch, fallbackFetch?: typeof fetch): typeof fetch {
  const resolved = fetchImpl ?? fallbackFetch ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new Error('Fetch implementation is required');
  }
  return resolved.bind(globalThis);
}

export async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw createNetworkTransportError(error, url, init.method ?? 'GET');
  }
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw createTransportError(response.status, url, init.method ?? 'GET', body);
  }
  return body as T;
}

export function createHttpJsonTransport(options: HttpJsonTransportOptions): HttpJsonTransport {
  const baseUrl = options.baseUrl.trim();
  const fetchImpl = createFetch(options.fetchImpl, options.fetch);
  const authToken = options.authToken ?? null;
  const defaultHeaders = options.headers;
  const retryPolicy = options.retry;
  const paths = createTransportPaths(baseUrl);

  const requestJsonForTransport = async <T>(pathOrUrl: string, requestOptions: HttpJsonRequestOptions = {}): Promise<T> => {
    const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
      ? pathOrUrl
      : buildUrl(baseUrl, pathOrUrl);
    const method = requestOptions.method ?? (requestOptions.body === undefined ? 'GET' : 'POST');
    const resolvedRetry = resolveHttpRetryPolicy(retryPolicy, requestOptions.retry);
    let attempt = 0;

    while (true) {
      attempt += 1;
      const token = await resolveAuthToken(authToken, options.getAuthToken);
      const headers = await resolveHeaders(defaultHeaders, options.getHeaders);
      try {
        return await requestJson<T>(
          fetchImpl,
          url,
          createJsonRequestInit(
            token,
            requestOptions.body,
            method,
            mergeHeaders(headers, requestOptions.headers),
            requestOptions.signal,
          ),
        );
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'transport' in error
          ? (error as { readonly transport?: { readonly status?: unknown } }).transport?.status
          : undefined;
        const shouldRetry = attempt < resolvedRetry.maxAttempts && (
          (typeof status === 'number' && status > 0 && isRetryableHttpStatus(method, status, resolvedRetry))
          || (typeof status === 'number' && status === 0 && isRetryableNetworkError(method, resolvedRetry))
        );
        if (!shouldRetry) {
          throw error;
        }
        await sleepWithSignal(getHttpRetryDelay(attempt + 1, resolvedRetry), requestOptions.signal);
      }
    }
  };

  const resolveContractRequest = (method: string, path: string, input: Record<string, unknown> = {}): ResolvedContractRequest => {
    const { interpolatedPath, remaining } = splitContractInput(path, input);
    const upperMethod = method.toUpperCase();
    const url = new URL(buildUrl(baseUrl, interpolatedPath));
    if (upperMethod === 'GET' || upperMethod === 'HEAD') {
      for (const [key, value] of Object.entries(remaining)) {
        addQueryValue(url, key, value);
      }
      return {
        url: url.toString(),
        method: upperMethod,
      };
    }
    const body = isPlainObject(remaining) && Object.keys(remaining).length > 0 ? remaining : undefined;
    return {
      url: url.toString(),
      method: upperMethod,
      ...(body ? { body } : {}),
    };
  };

  return {
    baseUrl: paths.baseUrl,
    authToken,
    fetchImpl,
    paths,
    buildUrl(path: string): string {
      return buildUrl(baseUrl, path);
    },
    async getAuthToken(): Promise<string | null> {
      return await resolveAuthToken(authToken, options.getAuthToken);
    },
    requestJson: requestJsonForTransport,
    resolveContractRequest,
  };
}
