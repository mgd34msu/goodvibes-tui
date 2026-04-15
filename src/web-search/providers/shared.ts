import type { ServiceRegistry } from '../../config/service-registry.ts';
import { executeFetchInput, type FetchOutput, type FetchUrlResult } from '@pellux/goodvibes-sdk/platform/tools/fetch/index';
import type { FetchAuthInput, FetchInput, FetchUrlInput } from '@pellux/goodvibes-sdk/platform/tools/fetch/schema';
import type { WebSearchEvidence, WebSearchProviderDescriptor, WebSearchResult } from '@pellux/goodvibes-sdk/platform/web-search/types';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

type EnvMap = Record<string, string | undefined>;
type FetchExecutor = (input: FetchInput) => Promise<FetchOutput>;

export interface SearchProviderContext {
  readonly fetcher?: FetchExecutor;
  readonly env: EnvMap;
  readonly serviceRegistry: Pick<ServiceRegistry, 'get'>;
}

export interface SearchProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly envKeyCandidates?: readonly string[];
  readonly serviceName?: string;
  readonly baseUrlEnvCandidates?: readonly string[];
  readonly defaultBaseUrl?: string;
  readonly requiresAuth?: boolean;
}

export interface JsonRequestConfig {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly params?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly service?: string;
  readonly auth?: FetchAuthInput;
  readonly fetcher?: FetchExecutor;
  readonly maxContentLength?: number;
}

export interface JsonRequestResult<T = unknown> {
  readonly payload: T;
  readonly response: FetchUrlResult;
}

export function resolveDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function trimSnippet(value: unknown, limit = 320): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function makeEvidence(
  url: string,
  content: unknown,
  metadata: Record<string, unknown> = {},
  extract: 'raw' | 'text' | 'json' | 'markdown' | 'readable' | 'code_blocks' | 'links' | 'metadata' | 'structured' | 'tables' | 'pdf' | 'summary' = 'summary',
): WebSearchEvidence[] | undefined {
  if (typeof content !== 'string') return undefined;
  const normalized = content.trim();
  if (!normalized) return undefined;
  return [{
    url,
    extract,
    content: normalized,
    tokensUsed: Math.ceil(normalized.length / 4),
    metadata,
  }];
}

export function withInlineApiKey(
  env: EnvMap,
  envKeys: readonly string[] | undefined,
  headerName: string,
): FetchAuthInput | undefined {
  if (!envKeys || envKeys.length === 0) return undefined;
  for (const key of envKeys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        type: 'api-key',
        header: headerName,
        key: value.trim(),
      };
    }
  }
  return undefined;
}

export function withInlineBearer(
  env: EnvMap,
  envKeys: readonly string[] | undefined,
): FetchAuthInput | undefined {
  if (!envKeys || envKeys.length === 0) return undefined;
  for (const key of envKeys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        type: 'bearer',
        token: value.trim(),
      };
    }
  }
  return undefined;
}

export function hasConfiguredCredential(
  serviceRegistry: Pick<ServiceRegistry, 'get'>,
  env: EnvMap,
  envKeys: readonly string[] | undefined,
  serviceName?: string,
): boolean {
  const envConfigured = (envKeys ?? []).some((key) => typeof env[key] === 'string' && env[key]!.trim().length > 0);
  if (envConfigured) return true;
  return Boolean(serviceName && serviceRegistry.get(serviceName));
}

export function resolveBaseUrl(
  serviceRegistry: Pick<ServiceRegistry, 'get'>,
  env: EnvMap,
  envKeys: readonly string[] | undefined,
  serviceName: string | undefined,
  defaultBaseUrl?: string,
): string | null {
  for (const key of envKeys ?? []) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().replace(/\/+$/, '');
    }
  }
  const configuredService = serviceName ? serviceRegistry.get(serviceName) : null;
  const serviceUrl = configuredService?.baseUrl?.trim();
  if (serviceUrl) return serviceUrl.replace(/\/+$/, '');
  return defaultBaseUrl ? defaultBaseUrl.replace(/\/+$/, '') : null;
}

export function buildDescriptor(
  config: SearchProviderConfig,
  context: SearchProviderContext,
): WebSearchProviderDescriptor {
  const configured = config.requiresAuth === false
    ? resolveBaseUrl(context.serviceRegistry, context.env, config.baseUrlEnvCandidates, config.serviceName, config.defaultBaseUrl) != null
    : hasConfiguredCredential(context.serviceRegistry, context.env, config.envKeyCandidates, config.serviceName);
  return {
    id: config.id,
    label: config.label,
    capabilities: ['search', 'evidence'],
    requiresAuth: config.requiresAuth ?? true,
    configured,
    note: config.note,
  };
}

export async function executeJsonRequest<T = unknown>(config: JsonRequestConfig): Promise<JsonRequestResult<T>> {
  const fetcher = config.fetcher ?? executeFetchInput;
  const urlInput: FetchUrlInput = {
    url: config.url,
    method: config.method ?? 'GET',
    extract: 'json',
    ...(config.params ? { params: config.params } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.body ? { body_type: 'json', body: JSON.stringify(config.body) } : {}),
    ...(config.service ? { service: config.service } : {}),
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.maxContentLength ? { max_content_length: config.maxContentLength } : {}),
  };
  const output = await fetcher({
    urls: [urlInput],
    parallel: false,
    verbosity: 'standard',
    sanitize_mode: 'safe-text',
    max_content_length: config.maxContentLength ?? 512_000,
  });
  const response = output.results?.[0];
  if (!response || response.error || typeof response.content !== 'string') {
    throw new Error(response?.error ?? `Search provider request failed for ${config.url}`);
  }
  let payload: T;
  try {
    payload = JSON.parse(response.content) as T;
  } catch (error) {
    throw new Error(`Search provider returned invalid JSON for ${config.url}: ${summarizeError(error)}`);
  }
  return { payload, response };
}

export function resultFromRecord(
  providerId: string,
  rank: number,
  record: Record<string, unknown>,
  options: {
    readonly urlKeys?: readonly string[];
    readonly titleKeys?: readonly string[];
    readonly snippetKeys?: readonly string[];
    readonly displayUrlKeys?: readonly string[];
    readonly evidenceKeys?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  } = {},
): WebSearchResult | null {
  const url = firstString(record, options.urlKeys ?? ['url', 'link', 'id']);
  if (!url) return null;
  return {
    rank,
    url,
    ...(firstString(record, options.titleKeys ?? ['title', 'name', 'heading']) ? { title: firstString(record, options.titleKeys ?? ['title', 'name', 'heading']) } : {}),
    ...(trimSnippet(firstString(record, options.snippetKeys ?? ['snippet', 'description', 'content', 'text'])) ? { snippet: trimSnippet(firstString(record, options.snippetKeys ?? ['snippet', 'description', 'content', 'text'])) } : {}),
    ...(firstString(record, options.displayUrlKeys ?? ['displayUrl', 'display_url']) ? { displayUrl: firstString(record, options.displayUrlKeys ?? ['displayUrl', 'display_url']) } : {}),
    ...(resolveDomain(url) ? { domain: resolveDomain(url) } : {}),
    type: 'organic',
    providerId,
    metadata: {
      ...(options.metadata ?? {}),
      ...(options.evidenceKeys
        ? {
            hasProviderEvidence: options.evidenceKeys.some((key) => typeof record[key] === 'string' && String(record[key]).trim().length > 0),
          }
        : {}),
    },
    ...(providerEvidence(url, record, options.evidenceKeys) ? { evidence: providerEvidence(url, record, options.evidenceKeys) } : {}),
  };
}

export function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function providerEvidence(
  url: string,
  record: Record<string, unknown>,
  keys: readonly string[] | undefined,
): WebSearchEvidence[] | undefined {
  for (const key of keys ?? []) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    return makeEvidence(url, value, { providerField: key });
  }
  return undefined;
}
