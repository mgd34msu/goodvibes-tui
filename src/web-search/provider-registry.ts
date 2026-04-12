import type {
  WebSearchProvider,
  WebSearchProviderDescriptor,
} from './types.ts';
import { createBraveSearchProvider } from './providers/brave.ts';
import { createDuckDuckGoProvider } from './providers/duckduckgo.ts';
import { createExaSearchProvider } from './providers/exa.ts';
import { createFirecrawlSearchProvider } from './providers/firecrawl.ts';
import { createPerplexitySearchProvider } from './providers/perplexity.ts';
import { createSearxngSearchProvider } from './providers/searxng.ts';
import { createTavilySearchProvider } from './providers/tavily.ts';

export class WebSearchProviderRegistry {
  private readonly providers = new Map<string, WebSearchProvider>();

  constructor() {
    this.register(createDuckDuckGoProvider(), { replace: true });
    this.register(createSearxngSearchProvider(), { replace: true });
    this.register(createBraveSearchProvider(), { replace: true });
    this.register(createExaSearchProvider(), { replace: true });
    this.register(createFirecrawlSearchProvider(), { replace: true });
    this.register(createTavilySearchProvider(), { replace: true });
    this.register(createPerplexitySearchProvider(), { replace: true });
  }

  register(provider: WebSearchProvider, options: { readonly replace?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Web search provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Web search provider already registered: ${id}`);
    }
    const registered = { ...provider, id };
    this.providers.set(id, registered);
    return () => {
      if (this.providers.get(id) === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): WebSearchProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): WebSearchProviderDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => provider.descriptor?.() ?? {
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
        requiresAuth: false,
        configured: true,
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  find(providerId?: string): WebSearchProvider | null {
    if (providerId) return this.get(providerId);
    return [...this.providers.values()][0] ?? null;
  }
}
