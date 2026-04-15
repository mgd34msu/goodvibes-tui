import { executeFetchInput, type FetchOutput } from '@pellux/goodvibes-sdk/platform/tools/fetch/index';
import type { FetchInput } from '@pellux/goodvibes-sdk/platform/tools/fetch/schema';
import type {
  WebSearchInstantAnswer,
  WebSearchProvider,
  WebSearchProviderResponse,
  WebSearchRelatedTopic,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSafeSearch,
  WebSearchTimeRange,
} from '@pellux/goodvibes-sdk/platform/web-search/types';

type FetchExecutor = (input: FetchInput) => Promise<FetchOutput>;

const DEFAULT_LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const DEFAULT_INSTANT_ENDPOINT = 'https://api.duckduckgo.com/';
const DEFAULT_SOURCE = 'goodvibes-tui';

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, ' '));
}

function resolveDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function mapSafeSearch(value: WebSearchSafeSearch | undefined): string | undefined {
  switch (value) {
    case 'strict':
      return '1';
    case 'off':
      return '-2';
    case 'moderate':
      return '-1';
    default:
      return undefined;
  }
}

function mapTimeRange(value: WebSearchTimeRange | undefined): string | undefined {
  switch (value) {
    case 'day':
      return 'd';
    case 'week':
      return 'w';
    case 'month':
      return 'm';
    case 'year':
      return 'y';
    default:
      return undefined;
  }
}

function unwrapDuckDuckGoRedirect(rawHref: string): string {
  try {
    const base = rawHref.startsWith('//') ? `https:${rawHref}` : new URL(rawHref, 'https://duckduckgo.com').toString();
    const url = new URL(base);
    const wrapped = url.searchParams.get('uddg');
    return wrapped ? decodeURIComponent(wrapped) : base;
  } catch {
    return rawHref;
  }
}

function parseOrganicResults(html: string): WebSearchResult[] {
  const anchorRe = /<a\b(?=[^>]*class=['"]result-link['"])[^>]*>([\s\S]*?)<\/a>/gi;
  const matches: Array<{ href: string; titleHtml: string; index: number }> = [];
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const tag = anchorMatch[0] ?? '';
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    matches.push({
      href: hrefMatch?.[1] ?? '',
      titleHtml: anchorMatch[1] ?? '',
      index: anchorMatch.index,
    });
  }

  const results: WebSearchResult[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const nextIndex = matches[i + 1]?.index ?? html.length;
    const segment = html.slice(Math.max(0, current.index - 200), nextIndex);
    const rankMatch = segment.match(/<td[^>]*valign=["']top["'][^>]*>\s*([0-9]+)\.\s*&nbsp;/i);
    const snippetMatch = segment.match(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    const displayMatch = segment.match(/<span[^>]*class=['"]link-text['"][^>]*>([\s\S]*?)<\/span>/i);
    const resolvedUrl = unwrapDuckDuckGoRedirect(current.href);
    results.push({
      rank: Number(rankMatch?.[1] ?? results.length + 1),
      url: resolvedUrl,
      title: stripTags(current.titleHtml),
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : undefined,
      displayUrl: displayMatch ? stripTags(displayMatch[1]) : undefined,
      domain: resolveDomain(resolvedUrl),
      type: 'organic',
      providerId: 'duckduckgo',
      metadata: {},
    });
  }

  return results;
}

function flattenRelatedTopics(items: unknown): WebSearchRelatedTopic[] {
  if (!Array.isArray(items)) return [];
  const related: WebSearchRelatedTopic[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.Text === 'string' && typeof record.FirstURL === 'string') {
      related.push({ text: record.Text, url: record.FirstURL });
      continue;
    }
    if (Array.isArray(record.Topics)) {
      related.push(...flattenRelatedTopics(record.Topics));
    }
  }
  return related;
}

function parseInstantAnswer(raw: unknown): WebSearchInstantAnswer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const answer = typeof record.Answer === 'string' ? record.Answer : undefined;
  const abstract = typeof record.Abstract === 'string' ? record.Abstract : undefined;
  const heading = typeof record.Heading === 'string' ? record.Heading : undefined;
  const url = typeof record.AbstractURL === 'string' ? record.AbstractURL : undefined;
  const source = typeof record.AbstractSource === 'string'
    ? record.AbstractSource
    : typeof record.DefinitionSource === 'string'
      ? record.DefinitionSource
      : undefined;
  const image = typeof record.Image === 'string' && record.Image.length > 0
    ? record.Image.startsWith('http') ? record.Image : `https://duckduckgo.com${record.Image}`
    : undefined;
  const type = typeof record.Type === 'string' ? record.Type : '';
  const related = flattenRelatedTopics(record.RelatedTopics);
  if (!answer && !abstract && !heading && related.length === 0) {
    return undefined;
  }
  return {
    heading,
    answer,
    abstract,
    source,
    url,
    image,
    type,
    related,
    metadata: {},
  };
}

export interface DuckDuckGoProviderOptions {
  readonly fetcher?: FetchExecutor;
  readonly liteEndpoint?: string;
  readonly instantEndpoint?: string;
  readonly source?: string;
}

export function createDuckDuckGoProvider(options: DuckDuckGoProviderOptions = {}): WebSearchProvider {
  const fetcher = options.fetcher ?? executeFetchInput;
  const liteEndpoint = options.liteEndpoint ?? DEFAULT_LITE_ENDPOINT;
  const instantEndpoint = options.instantEndpoint ?? DEFAULT_INSTANT_ENDPOINT;
  const source = options.source ?? DEFAULT_SOURCE;

  return {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    capabilities: ['search', 'instant_answer', 'evidence'],
    descriptor() {
      return {
        id: 'duckduckgo',
        label: 'DuckDuckGo',
        capabilities: ['search', 'instant_answer', 'evidence'],
        requiresAuth: false,
        configured: true,
        note: 'Uses lite.duckduckgo.com for organic results and api.duckduckgo.com for instant-answer enrichment.',
      };
    },
    async search(request: WebSearchRequest): Promise<WebSearchProviderResponse> {
      const maxResults = Math.max(1, Math.min(25, request.maxResults ?? 10));
      const liteBody: Record<string, string> = {
        q: request.query,
        t: source,
      };
      if (request.region) liteBody.kl = request.region;
      const safe = mapSafeSearch(request.safeSearch);
      if (safe) liteBody.kp = safe;
      const timeRange = mapTimeRange(request.timeRange);
      if (timeRange) liteBody.df = timeRange;

      const input: FetchInput = {
        urls: [
          {
            url: liteEndpoint,
            method: 'POST',
            body_type: 'form',
            body_data: liteBody,
            extract: 'raw',
          },
          ...(request.includeInstantAnswer === false ? [] : [{
            url: instantEndpoint,
            params: {
              q: request.query,
              format: 'json',
              no_html: '1',
              no_redirect: '1',
              skip_disambig: '1',
              t: source,
              ...(request.region ? { kl: request.region } : {}),
            },
            extract: 'json' as const,
          }]),
        ],
        parallel: true,
        verbosity: 'standard',
        sanitize_mode: 'safe-text',
        max_content_length: 250_000,
        ...(request.trustedHosts ? { trusted_hosts: [...request.trustedHosts] } : {}),
        ...(request.blockedHosts ? { blocked_hosts: [...request.blockedHosts] } : {}),
      };

      const output = await fetcher(input);
      const lite = output.results?.[0];
      if (!lite || lite.error || typeof lite.content !== 'string') {
        throw new Error(lite?.error ?? 'DuckDuckGo lite search failed');
      }
      const results = parseOrganicResults(lite.content).slice(0, maxResults);
      const instantRaw = output.results?.[1]?.content;
      let instantAnswer: WebSearchInstantAnswer | undefined;
      if (typeof instantRaw === 'string') {
        try {
          instantAnswer = parseInstantAnswer(JSON.parse(instantRaw));
        } catch {
          instantAnswer = undefined;
        }
      }
      return {
        results,
        ...(instantAnswer ? { instantAnswer } : {}),
        metadata: {
          organicStatus: lite.status,
          organicResultCount: results.length,
          ...(output.results?.[1]?.status ? { instantStatus: output.results[1].status } : {}),
        },
      };
    },
  };
}
