import type { Tool } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search/index';
import { WEB_SEARCH_TOOL_SCHEMA } from '@pellux/goodvibes-sdk/platform/tools/web-search/schema';

export function createWebSearchTool(service: WebSearchService): Tool {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web through a provider-backed search layer.'
        + ' Returns normalized ranked results, optional instant-answer data, and optional fetched evidence.',
      parameters: WEB_SEARCH_TOOL_SCHEMA as unknown as Record<string, unknown>,
      sideEffects: ['network'],
      concurrency: 'parallel',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(args: Record<string, unknown>) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { success: false, error: 'Missing query' };
      const output = await service.search({
        query,
        ...(typeof args.providerId === 'string' ? { providerId: args.providerId } : {}),
        ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
        ...(typeof args.verbosity === 'string' ? { verbosity: args.verbosity as import('@pellux/goodvibes-sdk/platform/web-search/types').WebSearchVerbosity } : {}),
        ...(typeof args.region === 'string' ? { region: args.region } : {}),
        ...(typeof args.safeSearch === 'string' ? { safeSearch: args.safeSearch as import('@pellux/goodvibes-sdk/platform/web-search/types').WebSearchSafeSearch } : {}),
        ...(typeof args.timeRange === 'string' ? { timeRange: args.timeRange as import('@pellux/goodvibes-sdk/platform/web-search/types').WebSearchTimeRange } : {}),
        ...(typeof args.includeInstantAnswer === 'boolean' ? { includeInstantAnswer: args.includeInstantAnswer } : {}),
        ...(typeof args.includeEvidence === 'boolean' ? { includeEvidence: args.includeEvidence } : {}),
        ...(typeof args.evidenceTopN === 'number' ? { evidenceTopN: args.evidenceTopN } : {}),
        ...(typeof args.evidenceExtract === 'string' ? { evidenceExtract: args.evidenceExtract as import('@pellux/goodvibes-sdk/platform/tools/fetch/schema').FetchExtractMode } : {}),
      });
      return { success: true, output: JSON.stringify(output) };
    },
  };
}
