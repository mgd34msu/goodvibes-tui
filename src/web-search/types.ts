import type { FetchExtractMode } from '../tools/fetch/schema.ts';

export type WebSearchVerbosity = 'urls_only' | 'titles' | 'snippets' | 'evidence' | 'full';
export type WebSearchSafeSearch = 'strict' | 'moderate' | 'off';
export type WebSearchTimeRange = 'any' | 'day' | 'week' | 'month' | 'year';
export type WebSearchResultType = 'organic' | 'instant_answer' | 'related_topic';
export type WebSearchProviderCapability = 'search' | 'instant_answer' | 'evidence';

export interface WebSearchEvidence {
  readonly url: string;
  readonly extract: FetchExtractMode;
  readonly content: string;
  readonly tokensUsed: number;
  readonly status?: number;
  readonly contentType?: string;
  readonly truncated?: boolean;
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchResult {
  readonly rank: number;
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly displayUrl?: string;
  readonly domain?: string;
  readonly type: WebSearchResultType;
  readonly providerId: string;
  readonly metadata: Record<string, unknown>;
  readonly evidence?: readonly WebSearchEvidence[];
}

export interface WebSearchRelatedTopic {
  readonly text: string;
  readonly url: string;
}

export interface WebSearchInstantAnswer {
  readonly heading?: string;
  readonly answer?: string;
  readonly abstract?: string;
  readonly source?: string;
  readonly url?: string;
  readonly image?: string;
  readonly type: string;
  readonly related: readonly WebSearchRelatedTopic[];
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly providerId?: string;
  readonly maxResults?: number;
  readonly verbosity?: WebSearchVerbosity;
  readonly region?: string;
  readonly safeSearch?: WebSearchSafeSearch;
  readonly timeRange?: WebSearchTimeRange;
  readonly includeInstantAnswer?: boolean;
  readonly includeEvidence?: boolean;
  readonly evidenceTopN?: number;
  readonly evidenceExtract?: FetchExtractMode;
  readonly trustedHosts?: readonly string[];
  readonly blockedHosts?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface WebSearchProviderResponse {
  readonly results: readonly WebSearchResult[];
  readonly instantAnswer?: WebSearchInstantAnswer;
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchResponse {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly query: string;
  readonly verbosity: WebSearchVerbosity;
  readonly results: readonly WebSearchResult[];
  readonly instantAnswer?: WebSearchInstantAnswer;
  readonly metadata: Record<string, unknown>;
}

export interface WebSearchProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly WebSearchProviderCapability[];
  readonly requiresAuth: boolean;
  readonly configured: boolean;
  readonly note?: string;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly WebSearchProviderCapability[];
  descriptor?(): WebSearchProviderDescriptor;
  search(request: WebSearchRequest): Promise<WebSearchProviderResponse>;
}
