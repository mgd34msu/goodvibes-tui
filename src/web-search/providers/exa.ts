import type { WebSearchProvider, WebSearchProviderResponse, WebSearchRequest } from '../types.ts';
import {
  buildDescriptor,
  executeJsonRequest,
  firstString,
  resultFromRecord,
  withInlineApiKey,
  type SearchProviderContext,
} from './shared.ts';

const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai';
const EXA_ENV_KEYS = ['EXA_API_KEY'] as const;
const EXA_SERVICE_NAME = 'exa';

export function createExaSearchProvider(context: SearchProviderContext = {}): WebSearchProvider {
  const env = context.env ?? process.env;
  const serviceRegistry = context.serviceRegistry;
  return {
    id: 'exa',
    label: 'Exa',
    capabilities: ['search', 'evidence'],
    descriptor() {
      return buildDescriptor({
        id: 'exa',
        label: 'Exa',
        note: 'Uses Exa Search JSON results. Configure via EXA_API_KEY or an exa service entry.',
        envKeyCandidates: EXA_ENV_KEYS,
        serviceName: EXA_SERVICE_NAME,
        defaultBaseUrl: EXA_DEFAULT_BASE_URL,
      }, { env, serviceRegistry });
    },
    async search(request: WebSearchRequest): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(25, request.maxResults ?? 10));
      const evidenceRequested = request.includeEvidence || request.verbosity === 'evidence' || request.verbosity === 'full';
      const baseUrl = (serviceRegistry?.get(EXA_SERVICE_NAME)?.baseUrl ?? EXA_DEFAULT_BASE_URL).replace(/\/+$/, '');
      const { payload } = await executeJsonRequest<Record<string, unknown>>({
        url: `${baseUrl}/search`,
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
          query: request.query,
          numResults: maxResults,
          ...(evidenceRequested ? { text: true } : {}),
        },
        service: serviceRegistry?.get(EXA_SERVICE_NAME) ? EXA_SERVICE_NAME : undefined,
        auth: serviceRegistry?.get(EXA_SERVICE_NAME) ? undefined : withInlineApiKey(env, EXA_ENV_KEYS, 'x-api-key'),
        fetcher: context.fetcher,
      });
      const results = Array.isArray(payload.results)
        ? payload.results
            .map((entry, index) => {
              if (!entry || typeof entry !== 'object') return null;
              const record = entry as Record<string, unknown>;
              const result = resultFromRecord('exa', index + 1, record, {
                urlKeys: ['url', 'id'],
                titleKeys: ['title'],
                snippetKeys: ['text', 'snippet'],
                evidenceKeys: ['text'],
                metadata: {
                  publishedDate: firstString(record, ['publishedDate', 'published_date']),
                  author: firstString(record, ['author']),
                },
              });
              return result;
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        : [];
      return {
        results,
        metadata: {
          autopromptString: firstString(payload, ['autopromptString']),
          requestId: firstString(payload, ['requestId']),
        },
      };
    },
  };
}
