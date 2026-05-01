import { POPULAR_PROVIDERS } from './model-picker-types.ts';

export function groupProviders(providers: readonly string[]): { popular: string[]; all: string[] } {
  const popular: string[] = [];
  const all: string[] = [];

  for (const provider of providers) {
    if (POPULAR_PROVIDERS.has(provider.toLowerCase())) {
      popular.push(provider);
    } else {
      all.push(provider);
    }
  }

  popular.sort((a, b) => a.localeCompare(b));
  all.sort((a, b) => a.localeCompare(b));

  return { popular, all };
}

export function filterProviders(providers: readonly string[], query: string): string[] {
  const { popular, all } = groupProviders(providers);
  const ordered = [...popular, ...all];
  const normalized = query.trim().toLowerCase();
  return normalized.length === 0
    ? ordered
    : ordered.filter((provider) => provider.toLowerCase().includes(normalized));
}
