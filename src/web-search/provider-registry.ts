import type {
  WebSearchProvider,
  WebSearchProviderDescriptor,
} from '@pellux/goodvibes-sdk/platform/web-search/types';
import { createBraveSearchProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/brave';
import { createDuckDuckGoProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/duckduckgo';
import { createExaSearchProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/exa';
import { createFirecrawlSearchProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/firecrawl';
import { createPerplexitySearchProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/perplexity';
import { createSearxngSearchProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/searxng';
import { createTavilySearchProvider } from '@pellux/goodvibes-sdk/platform/web-search/providers/tavily';
import type { SearchProviderContext } from '@pellux/goodvibes-sdk/platform/web-search/providers/shared';

export class WebSearchProviderRegistry {
  private readonly providers = new Map<string, WebSearchProvider>();

  constructor(context: SearchProviderContext) {
    this.register(createDuckDuckGoProvider(), { replace: true });
    this.register(createSearxngSearchProvider(context), { replace: true });
    this.register(createBraveSearchProvider(context), { replace: true });
    this.register(createExaSearchProvider(context), { replace: true });
    this.register(createFirecrawlSearchProvider(context), { replace: true });
    this.register(createTavilySearchProvider(context), { replace: true });
    this.register(createPerplexitySearchProvider(context), { replace: true });
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
