import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  WebSearchProviderRegistry,
  WebSearchService,
  createBraveSearchProvider,
  createDuckDuckGoProvider,
  createExaSearchProvider,
  createFirecrawlSearchProvider,
  createPerplexitySearchProvider,
  createSearxngSearchProvider,
  createTavilySearchProvider,
} from '@pellux/goodvibes-sdk/platform/web-search/index';
import type { SearchProviderContext } from '@pellux/goodvibes-sdk/platform/web-search/providers/shared';

const TEST_SEARCH_CONTEXT: SearchProviderContext = {
  env: {},
  serviceRegistry: {
    get: () => null,
  },
};

const DUCKDUCKGO_LITE_FIXTURE = `<!DOCTYPE html>
<html><body>
  <table border="0">
    <tr>
      <td valign="top">1.&nbsp;</td>
      <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2F" class='result-link'>TypeScript: JavaScript With Syntax For Types.</a></td>
    </tr>
    <tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'><b>TypeScript</b> is a strongly typed language for JavaScript.</td></tr>
    <tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>www.typescriptlang.org</span></td></tr>
    <tr><td>&nbsp;</td><td>&nbsp;</td></tr>
    <tr>
      <td valign="top">2.&nbsp;</td>
      <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.w3schools.com%2Ftypescript%2Findex.php" class='result-link'>TypeScript Tutorial - W3Schools</a></td>
    </tr>
    <tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Free online <b>TypeScript</b> tutorial.</td></tr>
    <tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>www.w3schools.com/typescript/index.php</span></td></tr>
  </table>
</body></html>`;

describe('DuckDuckGo web search provider', () => {
  test('parses lite organic results and instant-answer enrichment', async () => {
    const provider = createDuckDuckGoProvider({
      fetcher: async () => ({
        success: true,
        summary: { total: 2, succeeded: 2, failed: 0, total_ms: 3 },
        results: [
          {
            url: 'https://lite.duckduckgo.com/lite/',
            status: 200,
            contentType: 'text/html',
            content: DUCKDUCKGO_LITE_FIXTURE,
          },
          {
            url: 'https://api.duckduckgo.com/',
            status: 200,
            contentType: 'application/json',
            content: JSON.stringify({
              Heading: 'TypeScript',
              Abstract: 'TypeScript adds static typing to JavaScript.',
              AbstractURL: 'https://en.wikipedia.org/wiki/TypeScript',
              AbstractSource: 'Wikipedia',
              RelatedTopics: [
                { Text: 'TypeScript handbook', FirstURL: 'https://www.typescriptlang.org/docs/' },
                { Topics: [{ Text: 'Typed superset', FirstURL: 'https://example.com/typed-superset' }] },
              ],
            }),
          },
        ],
      }),
    });

    const response = await provider.search({ query: 'typescript', maxResults: 2 });
    expect(response.results).toHaveLength(2);
    expect(response.results[0]?.url).toBe('https://www.typescriptlang.org/');
    expect(response.results[0]?.title).toContain('TypeScript');
    expect(response.results[0]?.snippet).toContain('strongly typed');
    expect(response.results[0]?.displayUrl).toBe('www.typescriptlang.org');
    expect(response.instantAnswer?.heading).toBe('TypeScript');
    expect(response.instantAnswer?.related).toHaveLength(2);
  });
});

let evidenceServer: ReturnType<typeof Bun.serve>;
let evidenceBase = '';

beforeAll(() => {
  evidenceServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/one') {
        return new Response('<html><body><h1>One</h1><p>Evidence body one.</p></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/two') {
        return new Response('<html><body><h1>Two</h1><p>Evidence body two.</p></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('missing', { status: 404 });
    },
  });
  evidenceBase = `http://127.0.0.1:${evidenceServer.port}`;
});

afterAll(() => {
  evidenceServer.stop();
});

describe('WebSearchService', () => {
  test('shapes low-verbosity results and attaches evidence for evidence mode', async () => {
    const registry = new WebSearchProviderRegistry(TEST_SEARCH_CONTEXT);
    registry.register({
      id: 'test-search',
      label: 'Test Search',
      capabilities: ['search', 'evidence'],
      async search() {
        return {
          results: [
            {
              rank: 1,
              url: `${evidenceBase}/one`,
              title: 'Result One',
              snippet: 'Snippet one',
              displayUrl: '127.0.0.1/one',
              domain: '127.0.0.1',
              type: 'organic',
              providerId: 'test-search',
              metadata: {},
            },
            {
              rank: 2,
              url: `${evidenceBase}/two`,
              title: 'Result Two',
              snippet: 'Snippet two',
              displayUrl: '127.0.0.1/two',
              domain: '127.0.0.1',
              type: 'organic',
              providerId: 'test-search',
              metadata: {},
            },
          ],
          metadata: {},
        };
      },
    });

    const service = new WebSearchService(registry);
    const urlsOnly = await service.search({
      query: 'test query',
      providerId: 'test-search',
      verbosity: 'urls_only',
    });
    expect(urlsOnly.results[0]?.title).toBeUndefined();
    expect(urlsOnly.results[0]?.url).toContain('/one');

    const withEvidence = await service.search({
      query: 'test query',
      providerId: 'test-search',
      verbosity: 'evidence',
      includeEvidence: true,
      evidenceTopN: 1,
    });
    expect(withEvidence.results[0]?.evidence?.[0]?.content).toContain('Evidence body one');
    expect(withEvidence.results[1]?.evidence).toBeUndefined();
  });

  test('preserves provider-supplied evidence without refetching it away', async () => {
    const registry = new WebSearchProviderRegistry(TEST_SEARCH_CONTEXT);
    registry.register({
      id: 'provider-evidence',
      label: 'Provider Evidence',
      capabilities: ['search', 'evidence'],
      async search() {
        return {
          results: [{
            rank: 1,
            url: `${evidenceBase}/one`,
            title: 'Result One',
            snippet: 'Snippet one',
            domain: '127.0.0.1',
            type: 'organic',
            providerId: 'provider-evidence',
            metadata: {},
            evidence: [{
              url: `${evidenceBase}/one`,
              extract: 'summary',
              content: 'Provider supplied evidence',
              tokensUsed: 6,
              metadata: { source: 'provider' },
            }],
          }],
          metadata: {},
        };
      },
    });

    const service = new WebSearchService(registry);
    const result = await service.search({
      query: 'test query',
      providerId: 'provider-evidence',
      verbosity: 'evidence',
      includeEvidence: true,
      evidenceTopN: 1,
    });
    expect(result.results[0]?.evidence?.some((entry) => entry.content === 'Provider supplied evidence')).toBe(true);
    expect(result.results[0]?.evidence).toHaveLength(1);
  });
});

describe('additional web search providers', () => {
  test('parses Brave Search web results', async () => {
    const provider = createBraveSearchProvider({
      ...TEST_SEARCH_CONTEXT,
      fetcher: async () => ({
        success: true,
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{
          url: 'https://api.search.brave.com/res/v1/web/search',
          status: 200,
          contentType: 'application/json',
          content: JSON.stringify({
            query: { more_results_available: true },
            web: {
              results: [{
                title: 'Brave Result',
                url: 'https://example.com/brave',
                description: 'Brave snippet',
              }],
            },
          }),
        }],
      }),
    });

    const response = await provider.search({ query: 'brave query', maxResults: 1 });
    expect(response.results[0]?.title).toBe('Brave Result');
    expect(response.metadata.moreResultsAvailable).toBe(true);
  });

  test('parses Exa results with provider-supplied text evidence', async () => {
    const provider = createExaSearchProvider({
      ...TEST_SEARCH_CONTEXT,
      fetcher: async () => ({
        success: true,
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{
          url: 'https://api.exa.ai/search',
          status: 200,
          contentType: 'application/json',
          content: JSON.stringify({
            results: [{
              title: 'Exa Result',
              url: 'https://example.com/exa',
              text: 'Exa returned body text.',
              publishedDate: '2026-01-01',
            }],
          }),
        }],
      }),
    });

    const response = await provider.search({ query: 'exa query', maxResults: 1, includeEvidence: true });
    expect(response.results[0]?.title).toBe('Exa Result');
    expect(response.results[0]?.evidence?.[0]?.content).toContain('Exa returned body text.');
  });

  test('parses Firecrawl results with markdown evidence', async () => {
    const provider = createFirecrawlSearchProvider({
      ...TEST_SEARCH_CONTEXT,
      fetcher: async () => ({
        success: true,
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{
          url: 'https://api.firecrawl.dev/v1/search',
          status: 200,
          contentType: 'application/json',
          content: JSON.stringify({
            data: [{
              title: 'Firecrawl Result',
              url: 'https://example.com/firecrawl',
              description: 'Firecrawl snippet',
              markdown: '# Firecrawl\n\nEvidence body.',
            }],
          }),
        }],
      }),
    });

    const response = await provider.search({ query: 'firecrawl query', maxResults: 1, includeEvidence: true });
    expect(response.results[0]?.title).toBe('Firecrawl Result');
    expect(response.results[0]?.evidence?.[0]?.content).toContain('Evidence body.');
  });

  test('parses SearXNG JSON results', async () => {
    const provider = createSearxngSearchProvider({
      ...TEST_SEARCH_CONTEXT,
      env: { SEARXNG_BASE_URL: 'https://searx.example.test' },
      fetcher: async () => ({
        success: true,
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{
          url: 'https://searx.example.test/search',
          status: 200,
          contentType: 'application/json',
          content: JSON.stringify({
            number_of_results: 1,
            results: [{
              title: 'SearXNG Result',
              url: 'https://example.com/searxng',
              content: 'SearXNG snippet',
              engine: 'duckduckgo',
            }],
          }),
        }],
      }),
    });

    const response = await provider.search({ query: 'searx query', maxResults: 1 });
    expect(response.results[0]?.title).toBe('SearXNG Result');
    expect(response.metadata.numberOfResults).toBe(1);
  });

  test('parses Tavily results and answer metadata', async () => {
    const provider = createTavilySearchProvider({
      ...TEST_SEARCH_CONTEXT,
      fetcher: async () => ({
        success: true,
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{
          url: 'https://api.tavily.com/search',
          status: 200,
          contentType: 'application/json',
          content: JSON.stringify({
            answer: 'Tavily answer text',
            request_id: 'req-1',
            results: [{
              title: 'Tavily Result',
              url: 'https://example.com/tavily',
              content: 'Tavily snippet',
              raw_content: 'Tavily raw evidence',
            }],
          }),
        }],
      }),
    });

    const response = await provider.search({ query: 'tavily query', maxResults: 1, includeEvidence: true });
    expect(response.instantAnswer?.answer).toBe('Tavily answer text');
    expect(response.results[0]?.evidence?.[0]?.content).toContain('Tavily raw evidence');
  });

  test('parses Perplexity search API results and registers the provider by default', async () => {
    const provider = createPerplexitySearchProvider({
      ...TEST_SEARCH_CONTEXT,
      env: { PERPLEXITY_API_KEY: 'perplexity-test-key' },
      fetcher: async () => ({
        success: true,
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{
          url: 'https://api.perplexity.ai/search',
          status: 200,
          contentType: 'application/json',
          content: JSON.stringify({
            results: [{
              title: 'Perplexity Result',
              url: 'https://example.com/perplexity',
              snippet: 'Perplexity snippet',
              date: '2026-02-01',
            }],
          }),
        }],
      }),
    });

    const response = await provider.search({ query: 'perplexity query', maxResults: 1 });
    expect(response.results[0]?.title).toBe('Perplexity Result');
    expect(response.results[0]?.metadata.published).toBe('2026-02-01');

    const registry = new WebSearchProviderRegistry(TEST_SEARCH_CONTEXT);
    expect(registry.list().some((entry) => entry.id === 'perplexity')).toBe(true);
  });
});
