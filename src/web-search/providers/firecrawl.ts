import type { WebSearchProvider, WebSearchProviderResponse, WebSearchRequest } from '@pellux/goodvibes-sdk/platform/web-search/types';
import {
  buildDescriptor,
  executeJsonRequest,
  firstString,
  resultFromRecord,
  withInlineBearer,
  type SearchProviderContext,
} from '@pellux/goodvibes-sdk/platform/web-search/providers/shared';

const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const FIRECRAWL_ENV_KEYS = ['FIRECRAWL_API_KEY'] as const;
const FIRECRAWL_SERVICE_NAME = 'firecrawl';

function mapTimeRange(value: WebSearchRequest['timeRange']): string | undefined {
  switch (value) {
    case 'day':
      return 'qdr:d';
    case 'week':
      return 'qdr:w';
    case 'month':
      return 'qdr:m';
    case 'year':
      return 'qdr:y';
    default:
      return undefined;
  }
}

export function createFirecrawlSearchProvider(context: SearchProviderContext): WebSearchProvider {
  const env = context.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'firecrawl',
    label: 'Firecrawl',
    capabilities: ['search', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'firecrawl',
        label: 'Firecrawl',
        note: 'Uses Firecrawl search JSON results. Configure via FIRECRAWL_API_KEY or a firecrawl service entry.',
        envKeyCandidates: FIRECRAWL_ENV_KEYS,
        serviceName: FIRECRAWL_SERVICE_NAME,
        defaultBaseUrl: FIRECRAWL_DEFAULT_BASE_URL,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(20, request.maxResults ?? 10));
      const evidenceRequested = request.includeEvidence || request.verbosity === 'evidence' || request.verbosity === 'full';
      const baseUrl = (serviceRegistry.get(FIRECRAWL_SERVICE_NAME)?.baseUrl ?? FIRECRAWL_DEFAULT_BASE_URL).replace(/\/+$/, '');
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/v1/search`,
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
          query: request.query,
          limit: maxResults,
          ...(mapTimeRange(request.timeRange) ? { tbs: mapTimeRange(request.timeRange)! } : {}),
          ...(evidenceRequested ? { scrapeOptions: { formats: ['markdown'] } } : {}),
        },
        service: serviceRegistry.get(FIRECRAWL_SERVICE_NAME) ? FIRECRAWL_SERVICE_NAME : undefined,
        auth: serviceRegistry.get(FIRECRAWL_SERVICE_NAME) ? undefined : withInlineBearer(env, FIRECRAWL_ENV_KEYS),
        fetcher: context.fetcher,
      });
      const data = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray((payload.results as unknown[] | undefined))
          ? payload.results as unknown[]
          : [];
      const results = data
        .map((entry, index) => {
          if (!entry || typeof entry !== 'object') return null;
          const record = entry as Record<string, unknown>;
          return resultFromRecord('firecrawl', index + 1, record, {
            urlKeys: ['url'],
            titleKeys: ['title'],
            snippetKeys: ['description', 'snippet', 'markdown'],
            evidenceKeys: ['markdown'],
          });
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return {
        results,
        metadata: {
          requestId: firstString(payload, ['id', 'requestId']),
        },
      };
    },
  };
}
