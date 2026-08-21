// ---------------------------------------------------------------------------
// websearch-runtime.test.ts, /search
//
// Pure command-layer test: a fake WebSearchService on ctx.platform (no real
// network calls), following the project's existing runtime-command test
// pattern (see workstream-runtime-command.test.ts's makeCtx()). Exercises:
// the service-absent guard, empty-query usage message, rendering ranked
// results + instant answer + source label, the no-results case, --limit
// parsing, and honest failure rendering when search() throws.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerWebSearchRuntimeCommands } from '../../input/commands/websearch-runtime.ts';

interface FakeSearchResponse {
  providerId: string;
  providerLabel: string;
  query: string;
  verbosity: string;
  results: Array<{ rank: number; url: string; title?: string; snippet?: string; displayUrl?: string; type: string; providerId: string; metadata: Record<string, unknown> }>;
  instantAnswer?: { heading?: string; answer?: string; abstract?: string; source?: string; url?: string; type: string; related: unknown[]; metadata: Record<string, unknown> };
  metadata: Record<string, unknown>;
}

function makeFakeService(options: {
  response?: FakeSearchResponse;
  throwError?: Error;
  status?: { enabled: boolean; providerCount: number; providers: unknown[]; note: string };
} = {}) {
  const calls: Array<{ query: string; maxResults?: number }> = [];
  return {
    calls,
    search: async (request: { query: string; maxResults?: number }) => {
      calls.push(request);
      if (options.throwError) throw options.throwError;
      return options.response ?? {
        providerId: 'duckduckgo',
        providerLabel: 'DuckDuckGo',
        query: request.query,
        verbosity: 'snippets',
        results: [],
        metadata: {},
      };
    },
    getStatus: async () => options.status ?? { enabled: true, providerCount: 1, providers: [], note: 'ok' },
  };
}

function makeCtx(webSearchService?: ReturnType<typeof makeFakeService>) {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    session: {},
    workspace: {},
    provider: {},
    platform: { webSearchService },
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('/search command registration', () => {
  test('registers /search', () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    expect(registry.get('search')).toBeDefined();
  });
});

describe('/search: honest degradation', () => {
  test('prints an honest message when webSearchService is not available', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(undefined);

    await registry.execute('search', ['weather'], ctx);

    expect(printed).toEqual(['Web search is not available in this session.']);
  });

  test('prints usage when no query is given', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('search', [], ctx);

    expect(printed).toEqual(['Usage: /search <query> [--limit <n>]']);
    expect(service.calls).toHaveLength(0);
  });

  test('renders a failure message from a thrown error, without inventing one', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const service = makeFakeService({ throwError: new Error('No web search provider is registered') });
    const { ctx, printed } = makeCtx(service);

    await registry.execute('search', ['weather'], ctx);

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Search failed:');
    expect(printed[0]).toContain('No web search provider is registered');
  });
});

describe('/search: results rendering', () => {
  test('renders ranked results with a source label', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const service = makeFakeService({
      response: {
        providerId: 'duckduckgo',
        providerLabel: 'DuckDuckGo',
        query: 'weather',
        verbosity: 'snippets',
        results: [
          { rank: 1, url: 'https://example.com/a', title: 'A', snippet: 'about a', type: 'organic', providerId: 'duckduckgo', metadata: {} },
          { rank: 2, url: 'https://example.com/b', title: 'B', type: 'organic', providerId: 'duckduckgo', metadata: {} },
        ],
        metadata: {},
      },
    });
    const { ctx, printed } = makeCtx(service);

    await registry.execute('search', ['weather'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('Search: "weather"');
    expect(text).toContain('source: DuckDuckGo');
    expect(text).toContain('1. A');
    expect(text).toContain('about a');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('2. B');
  });

  test('renders the instant answer when present', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const service = makeFakeService({
      response: {
        providerId: 'duckduckgo',
        providerLabel: 'DuckDuckGo',
        query: 'capital of france',
        verbosity: 'snippets',
        results: [],
        instantAnswer: { heading: 'Paris', answer: 'Paris is the capital of France.', type: 'answer', related: [], metadata: {} },
        metadata: {},
      },
    });
    const { ctx, printed } = makeCtx(service);

    await registry.execute('search', ['capital', 'of', 'france'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('Paris: Paris is the capital of France.');
  });

  test('states plainly when there are no results', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx, printed } = makeCtx(service);

    await registry.execute('search', ['zzzznonexistentzzz'], ctx);

    expect(printed.join('\n')).toContain('No results found.');
  });

  test('--limit is parsed and forwarded as maxResults', async () => {
    const registry = new CommandRegistry();
    registerWebSearchRuntimeCommands(registry);
    const service = makeFakeService();
    const { ctx } = makeCtx(service);

    await registry.execute('search', ['weather', 'today', '--limit', '3'], ctx);

    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toEqual({ query: 'weather today', maxResults: 3 });
  });
});
