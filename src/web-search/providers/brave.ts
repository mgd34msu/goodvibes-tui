import type { WebSearchProvider, WebSearchProviderResponse, WebSearchRequest } from '../types.ts';
import {
  buildDescriptor,
  executeJsonRequest,
  resolveDomain,
  resultFromRecord,
  withInlineApiKey,
  type SearchProviderContext,
} from './shared.ts';

const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com';
const BRAVE_ENV_KEYS = ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'] as const;
const BRAVE_SERVICE_NAME = 'brave-search';

function mapSafeSearch(value: WebSearchRequest['safeSearch']): string | undefined {
  switch (value) {
    case 'strict':
      return 'strict';
    case 'off':
      return 'off';
    case 'moderate':
      return 'moderate';
    default:
      return undefined;
  }
}

export function createBraveSearchProvider(context: SearchProviderContext): WebSearchProvider {
  const env = context.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'brave',
    label: 'Brave Search',
    capabilities: ['search', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'brave',
        label: 'Brave Search',
        note: 'Uses Brave Search JSON results. Configure via BRAVE_SEARCH_API_KEY or a brave-search service entry.',
        envKeyCandidates: BRAVE_ENV_KEYS,
        serviceName: BRAVE_SERVICE_NAME,
        defaultBaseUrl: BRAVE_DEFAULT_BASE_URL,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(20, request.maxResults ?? 10));
      const baseUrl = (serviceRegistry.get(BRAVE_SERVICE_NAME)?.baseUrl ?? BRAVE_DEFAULT_BASE_URL).replace(/\/+$/, '');
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/res/v1/web/search`,
        params: {
          q: request.query,
          count: String(maxResults),
          ...(mapSafeSearch(request.safeSearch) ? { safesearch: mapSafeSearch(request.safeSearch)! } : {}),
        },
        headers: { Accept: 'application/json' },
        service: serviceRegistry.get(BRAVE_SERVICE_NAME) ? BRAVE_SERVICE_NAME : undefined,
        auth: serviceRegistry.get(BRAVE_SERVICE_NAME) ? undefined : withInlineApiKey(env, BRAVE_ENV_KEYS, 'X-Subscription-Token'),
        fetcher: context.fetcher,
      });
      const web = payload.web;
      const results = Array.isArray((web as Record<string, unknown> | undefined)?.results)
        ? ((web as Record<string, unknown>).results as unknown[])
            .map((entry, index) => {
              if (!entry || typeof entry !== 'object') return null;
              const record = entry as Record<string, unknown>;
              const result = resultFromRecord('brave', index + 1, record, {
                urlKeys: ['url'],
                titleKeys: ['title'],
                snippetKeys: ['description'],
                metadata: {
                  age: typeof record.age === 'string' ? record.age : undefined,
                  language: typeof record.language === 'string' ? record.language : undefined,
                },
              });
              if (!result) return null;
              const profile = record.profile;
              return profile && typeof profile === 'object'
                ? {
                    ...result,
                    displayUrl: typeof (profile as Record<string, unknown>).long_name === 'string'
                      ? String((profile as Record<string, unknown>).long_name)
                      : result.displayUrl,
                    domain: result.domain ?? resolveDomain(result.url),
                  }
                : result;
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        : [];
      const query = payload.query;
      return {
        results,
        metadata: {
          moreResultsAvailable: Boolean(
            query && typeof query === 'object' && (query as Record<string, unknown>).more_results_available,
          ),
        },
      };
    },
  };
}
