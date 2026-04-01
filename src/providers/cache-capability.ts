/** Cache capability types for LLM providers. */

export type CacheType = 'explicit' | 'automatic' | 'implicit' | 'none';

export interface ExplicitCacheCapability {
  type: 'explicit';
  maxBreakpoints: number;
  ttlOptions: Array<{ label: string; seconds: number; writeCostMultiplier: number }>;
  readDiscount: number;        // 0.1 = 90% off input price
  minCacheableTokens: number;  // Minimum prefix tokens to enable caching
}

export interface AutomaticCacheCapability {
  type: 'automatic';
  readDiscount: number;        // e.g. 0.5 = 50% off
  sessionAffinityHeader?: string; // e.g. 'x-session-affinity' for Fireworks
}

export interface ImplicitCacheCapability {
  type: 'implicit';
  keepAliveParam?: string;     // e.g. 'keep_alive' for Ollama
  defaultKeepAliveSeconds?: number;
}

export interface NoCacheCapability {
  type: 'none';
}

export type ProviderCacheCapability =
  | ExplicitCacheCapability
  | AutomaticCacheCapability
  | ImplicitCacheCapability
  | NoCacheCapability;

/**
 * Priority-ordered alias map for provider name substring matching.
 * More specific patterns must appear before more general ones.
 * Used as a fallback when no direct match is found in the registry.
 */
const PROVIDER_ALIASES: Array<[string, string]> = [
  // OpenRouter uses OpenAI-compatible caching
  ['openrouter', 'openai'],
  // anthropic-compat style providers map to anthropic caching
  ['anthropic-compat', 'anthropic'],
];

// Registry of known provider capabilities
// Map provider name -> capability
const PROVIDER_CACHE_CAPABILITIES = {
  anthropic: {
    type: 'explicit',
    maxBreakpoints: 4,
    ttlOptions: [
      { label: '5m', seconds: 300, writeCostMultiplier: 1.25 },
      { label: '1h', seconds: 3600, writeCostMultiplier: 2.0 },
    ],
    readDiscount: 0.1,
    minCacheableTokens: 1024,
  },
  gemini: {
    type: 'explicit',
    maxBreakpoints: 1, // Gemini uses cachedContents objects, effectively 1 cache object at a time
    ttlOptions: [
      { label: 'configurable', seconds: 3600, writeCostMultiplier: 1.0 }, // standard + storage/hr
    ],
    readDiscount: 0.25, // 75% off
    minCacheableTokens: 32768,
  },
  openai: {
    type: 'automatic',
    readDiscount: 0.5,
  },
  deepseek: {
    type: 'automatic',
    readDiscount: 0.1,
  },
  groq: {
    type: 'automatic',
    readDiscount: 0.5,
  },
  fireworks: {
    type: 'automatic',
    readDiscount: 0.5,
    sessionAffinityHeader: 'x-session-affinity',
  },
  together: {
    type: 'automatic',
    readDiscount: 0.5,
  },
  // Local runtimes
  ollama: {
    type: 'implicit',
    keepAliveParam: 'keep_alive',
    defaultKeepAliveSeconds: -1, // -1 = keep loaded indefinitely
  },
  lmstudio: {
    type: 'implicit',
  },
  vllm: {
    type: 'implicit', // Automatic prefix caching in GPU memory
  },
  'llama.cpp': {
    type: 'implicit',
  },
  sglang: {
    type: 'implicit', // RadixAttention — best automatic local caching
  },
  // No caching
  mistral: {
    type: 'none',
  },
} as const satisfies Record<string, ProviderCacheCapability>;

/**
 * Get the cache capability for a provider.
 * Returns 'none' for unknown providers.
 */
export function getCacheCapability(providerName: string): ProviderCacheCapability {
  // Normalize provider name (lowercase, strip trailing whitespace)
  const normalized = providerName.toLowerCase().trim();

  // Check direct match
  const normalizedKey = normalized as keyof typeof PROVIDER_CACHE_CAPABILITIES;
  if (PROVIDER_CACHE_CAPABILITIES[normalizedKey]) {
    return PROVIDER_CACHE_CAPABILITIES[normalizedKey];
  }

  // Known aliases (priority-ordered: more specific patterns first)
  for (const [alias, target] of PROVIDER_ALIASES) {
    const aliasTarget = target as keyof typeof PROVIDER_CACHE_CAPABILITIES;
    if (normalized.includes(alias) && PROVIDER_CACHE_CAPABILITIES[aliasTarget]) {
      return PROVIDER_CACHE_CAPABILITIES[aliasTarget];
    }
  }

  // Unknown provider — no caching
  return { type: 'none' };
}

/**
 * Check if a provider supports any form of caching.
 *
 * @remarks Intentionally exported for future consumers such as UI display
 * components and config validation that need a simple boolean check.
 */
export function supportsCaching(providerName: string): boolean {
  return getCacheCapability(providerName).type !== 'none';
}

/** Get the best TTL option for stable content (system prompt + tools). */
export function getStableTtl(cap: ProviderCacheCapability): { label: string; seconds: number } | null {
  if (cap.type !== 'explicit') return null;
  // Prefer the longest TTL for stable content
  const sorted = [...cap.ttlOptions].sort((a, b) => b.seconds - a.seconds);
  return sorted[0] ? { label: sorted[0].label, seconds: sorted[0].seconds } : null;
}

/** Get the default (shortest) TTL for dynamic content. */
export function getDynamicTtl(cap: ProviderCacheCapability): { label: string; seconds: number } | null {
  if (cap.type !== 'explicit') return null;
  const sorted = [...cap.ttlOptions].sort((a, b) => a.seconds - b.seconds);
  return sorted[0] ? { label: sorted[0].label, seconds: sorted[0].seconds } : null;
}
