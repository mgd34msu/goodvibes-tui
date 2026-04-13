import type { WebSearchProvider, WebSearchProviderResponse, WebSearchRequest } from '../types.ts';
import {
  buildDescriptor,
  executeJsonRequest,
  resultFromRecord,
  withInlineBearer,
  type SearchProviderContext,
} from './shared.ts';

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
const PERPLEXITY_ENV_KEYS = ['PERPLEXITY_API_KEY'] as const;
const PERPLEXITY_SERVICE_NAME = 'perplexity';

function mapTimeRange(value: WebSearchRequest['timeRange']): string | undefined {
  switch (value) {
    case 'day':
      return 'day';
    case 'week':
      return 'week';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return undefined;
  }
}

export function createPerplexitySearchProvider(context: SearchProviderContext): WebSearchProvider {
  const env = context.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'perplexity',
    label: 'Perplexity',
    capabilities: ['search', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'perplexity',
        label: 'Perplexity',
        note: 'Uses Perplexity search API results when PERPLEXITY_API_KEY or a perplexity service entry is configured.',
        envKeyCandidates: PERPLEXITY_ENV_KEYS,
        serviceName: PERPLEXITY_SERVICE_NAME,
        defaultBaseUrl: PERPLEXITY_BASE_URL,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(10, request.maxResults ?? 10));
      const baseUrl = (serviceRegistry.get(PERPLEXITY_SERVICE_NAME)?.baseUrl ?? PERPLEXITY_BASE_URL).replace(/\/+$/, '');
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/search`,
        method: 'POST',
        headers: { Accept: 'application/json' },
        service: serviceRegistry.get(PERPLEXITY_SERVICE_NAME) ? PERPLEXITY_SERVICE_NAME : undefined,
        auth: serviceRegistry.get(PERPLEXITY_SERVICE_NAME) ? undefined : withInlineBearer(env, PERPLEXITY_ENV_KEYS),
        body: {
          query: request.query,
          max_results: maxResults,
          ...(request.region?.trim() ? { country: request.region.trim() } : {}),
          ...(mapTimeRange(request.timeRange) ? { search_recency_filter: mapTimeRange(request.timeRange) } : {}),
        },
        fetcher: context.fetcher,
      });
      const rawResults = Array.isArray(payload['results']) ? payload['results'] : [];
      const results = rawResults
        .map((entry, index) => {
          if (!entry || typeof entry !== 'object') return null;
          const record = entry as Record<string, unknown>;
          return resultFromRecord('perplexity', index + 1, record, {
            urlKeys: ['url'],
            titleKeys: ['title'],
            snippetKeys: ['snippet', 'description'],
            metadata: {
              published: typeof record['date'] === 'string' ? record['date'] : undefined,
            },
          });
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return {
        results,
        metadata: {
          provider: 'perplexity',
        },
      };
    },
  };
}
