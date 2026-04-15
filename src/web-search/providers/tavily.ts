import type { WebSearchInstantAnswer, WebSearchProvider, WebSearchProviderResponse, WebSearchRequest } from '@pellux/goodvibes-sdk/platform/web-search/types';
import {
  buildDescriptor,
  executeJsonRequest,
  firstString,
  resultFromRecord,
  withInlineBearer,
  type SearchProviderContext,
} from './shared.ts';

const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
const TAVILY_ENV_KEYS = ['TAVILY_API_KEY'] as const;
const TAVILY_SERVICE_NAME = 'tavily';

function buildInstantAnswer(payload: Record<string, unknown>): WebSearchInstantAnswer | undefined {
  const answer = firstString(payload, ['answer']);
  if (!answer) return undefined;
  return {
    heading: 'Tavily Answer',
    answer,
    type: 'answer',
    related: [],
    metadata: {},
  };
}

export function createTavilySearchProvider(context: SearchProviderContext): WebSearchProvider {
  const env = context.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'tavily',
    label: 'Tavily',
    capabilities: ['search', 'instant_answer', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'tavily',
        label: 'Tavily',
        note: 'Uses Tavily Search JSON results. Configure via TAVILY_API_KEY or a tavily service entry.',
        envKeyCandidates: TAVILY_ENV_KEYS,
        serviceName: TAVILY_SERVICE_NAME,
        defaultBaseUrl: TAVILY_DEFAULT_BASE_URL,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(20, request.maxResults ?? 10));
      const baseUrl = (serviceRegistry.get(TAVILY_SERVICE_NAME)?.baseUrl ?? TAVILY_DEFAULT_BASE_URL).replace(/\/+$/, '');
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/search`,
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
          query: request.query,
          max_results: maxResults,
          include_answer: request.includeInstantAnswer !== false,
          search_depth: request.includeEvidence || request.verbosity === 'evidence' || request.verbosity === 'full'
            ? 'advanced'
            : 'basic',
        },
        service: serviceRegistry.get(TAVILY_SERVICE_NAME) ? TAVILY_SERVICE_NAME : undefined,
        auth: serviceRegistry.get(TAVILY_SERVICE_NAME) ? undefined : withInlineBearer(env, TAVILY_ENV_KEYS),
        fetcher: context.fetcher,
      });
      const results = Array.isArray(payload.results)
        ? payload.results
            .map((entry, index) => {
              if (!entry || typeof entry !== 'object') return null;
              const record = entry as Record<string, unknown>;
              return resultFromRecord('tavily', index + 1, record, {
                urlKeys: ['url'],
                titleKeys: ['title'],
                snippetKeys: ['content'],
                evidenceKeys: ['raw_content'],
                metadata: {
                  score: typeof record.score === 'number' ? record.score : undefined,
                },
              });
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        : [];
      return {
        results,
        ...(buildInstantAnswer(payload) ? { instantAnswer: buildInstantAnswer(payload) } : {}),
        metadata: {
          requestId: firstString(payload, ['request_id']),
          responseTime: firstString(payload, ['response_time']),
        },
      };
    },
  };
}
