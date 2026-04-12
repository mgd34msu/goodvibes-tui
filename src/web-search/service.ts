import { FetchRuntimeService, type FetchRuntimeDeps } from '../tools/fetch/index.ts';
import type { FetchExtractMode } from '../tools/fetch/schema.ts';
import { WebSearchProviderRegistry } from './provider-registry.ts';
import type {
  WebSearchEvidence,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
  WebSearchVerbosity,
} from './types.ts';

export interface WebSearchServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: ReturnType<WebSearchProviderRegistry['list']>;
  readonly note: string;
}

function selectEvidenceExtract(request: WebSearchRequest, verbosity: WebSearchVerbosity): FetchExtractMode {
  if (request.evidenceExtract) return request.evidenceExtract;
  return verbosity === 'full' ? 'readable' : 'summary';
}

function shapeResultForVerbosity(result: WebSearchResult, verbosity: WebSearchVerbosity): WebSearchResult {
  switch (verbosity) {
    case 'urls_only':
      return {
        rank: result.rank,
        url: result.url,
        ...(result.domain ? { domain: result.domain } : {}),
        type: result.type,
        providerId: result.providerId,
        metadata: result.metadata,
      };
    case 'titles':
      return {
        ...shapeResultForVerbosity(result, 'urls_only'),
        ...(result.title ? { title: result.title } : {}),
        ...(result.displayUrl ? { displayUrl: result.displayUrl } : {}),
      };
    case 'snippets':
      return {
        ...shapeResultForVerbosity(result, 'titles'),
        ...(result.snippet ? { snippet: result.snippet } : {}),
      };
    default:
      return result;
  }
}

export class WebSearchService {
  private readonly fetchRuntime = new FetchRuntimeService();

  constructor(
    private readonly registry: WebSearchProviderRegistry,
    private readonly fetchDeps: FetchRuntimeDeps = {},
  ) {}

  async getStatus(): Promise<WebSearchServiceStatus> {
    const providers = this.registry.list();
    return {
      enabled: providers.length > 0,
      providerCount: providers.length,
      providers,
      note: 'Web search uses provider-backed discovery and normalizes results before they reach the model.',
    };
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const provider = this.registry.find(request.providerId);
    if (!provider) {
      throw new Error(request.providerId ? `Web search provider unavailable: ${request.providerId}` : 'No web search provider is registered');
    }

    const verbosity = request.verbosity ?? 'snippets';
    const baseResponse = await provider.search(request);
    const evidenceEnabled = request.includeEvidence || verbosity === 'evidence' || verbosity === 'full';
    const resultsWithEvidence = evidenceEnabled
      ? await this.attachEvidence(baseResponse.results, request)
      : baseResponse.results;
    const shapedResults = resultsWithEvidence.map((result) => shapeResultForVerbosity(result, verbosity));

    return {
      providerId: provider.id,
      providerLabel: provider.label,
      query: request.query,
      verbosity,
      results: shapedResults,
      ...(baseResponse.instantAnswer ? { instantAnswer: baseResponse.instantAnswer } : {}),
      metadata: baseResponse.metadata,
    };
  }

  private async attachEvidence(results: readonly WebSearchResult[], request: WebSearchRequest): Promise<readonly WebSearchResult[]> {
    const evidenceTopN = Math.max(1, Math.min(10, request.evidenceTopN ?? 3));
    const extract = selectEvidenceExtract(request, request.verbosity ?? 'snippets');
    const selectedIndexes = results
      .map((result, index) => ({ result, index }))
      .filter(({ result, index }) => index < evidenceTopN && (!result.evidence || result.evidence.length === 0));
    if (selectedIndexes.length === 0) return results;

    const fetched = await this.fetchRuntime.execute({
      urls: selectedIndexes.map(({ result }) => ({
        url: result.url,
        extract,
        max_content_length: extract === 'readable' ? 20_000 : 10_000,
      })),
      parallel: true,
      verbosity: 'standard',
      sanitize_mode: 'safe-text',
      ...(request.trustedHosts ? { trusted_hosts: [...request.trustedHosts] } : {}),
      ...(request.blockedHosts ? { blocked_hosts: [...request.blockedHosts] } : {}),
    }, this.fetchDeps);

    const evidenceByUrl = new Map<string, WebSearchEvidence>();
    for (const result of fetched.results ?? []) {
      if (!result.content || result.error) continue;
      evidenceByUrl.set(result.url, {
        url: result.final_url ?? result.url,
        extract,
        content: result.content,
        tokensUsed: result.tokens_used ?? Math.ceil(result.content.length / 4),
        ...(result.status ? { status: result.status } : {}),
        ...(result.contentType ? { contentType: result.contentType } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        metadata: {
          redirected: result.redirected ?? false,
        },
      });
    }

    return results.map((result) => {
      const evidence = evidenceByUrl.get(result.url);
      if (!evidence) return result;
      return {
        ...result,
        evidence: [...(result.evidence ?? []), evidence],
      };
    });
  }
}
