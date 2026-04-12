import type {
  ProviderCacheCapability,
  ExplicitCacheCapability,
} from './cache-capability.ts';
import { getCacheCapability, getStableTtl, getDynamicTtl } from './cache-capability.ts';
import { logger } from '../utils/logger.ts';

/** Position where a cache breakpoint should be placed. */
export type BreakpointPosition =
  | 'system_and_tools'      // BP1: After system prompt + tool definitions
  | 'conversation_prefix'   // BP2: After the last assistant message before current turn
  | 'last_tool_result'      // BP3: After the largest tool result in recent history
  | 'dynamic';              // BP4: Reserved for dynamic placement

/** A single cache breakpoint instruction. */
export interface CacheBreakpoint {
  position: BreakpointPosition;
  ttl: string;               // '5m' or '1h'
  ttlSeconds: number;
  reason: string;
}

/** Complete cache strategy for a provider request. */
export interface CacheStrategy {
  /** Breakpoints to place (for explicit providers only). Ordered by position in content. */
  breakpoints: CacheBreakpoint[];
  /** Whether prefix stability should be enforced (universal — true for all caching providers). */
  prefixStable: boolean;
  /** Session affinity header to send (for providers like Fireworks). */
  sessionAffinityHeader?: string;
  /** Keep-alive duration hint for local runtimes (seconds, -1 = indefinite). */
  keepAliveSeconds?: number;
  /** Re-evaluate strategy after this many turns. */
  refreshAfterTurns: number;
}

/** Context needed to generate a cache strategy. */
export interface CacheContext {
  providerName: string;
  systemPromptTokens: number;
  toolCount: number;
  toolTokens: number;
  conversationTurns: number;
  conversationTokens: number;
  /** Recent cache hit rate (0-1). Undefined if not yet tracked. */
  recentCacheHitRate?: number;
  /** Whether the user has configured a custom TTL preference. Accepts any TTL label string to accommodate future provider options. */
  configuredTtl?: string;
}

/** Cache hit rate tracking. */
export interface CacheHitMetrics {
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Computed hit rate: cacheReadTokens / (totalInputTokens + cacheReadTokens) */
  hitRate: number;
  /** Number of turns tracked. */
  turns: number;
}

/**
 * Generate the default cache strategy for a provider based on its capabilities.
 */
export function getDefaultStrategy(context: CacheContext): CacheStrategy {
  const cap = getCacheCapability(context.providerName);

  switch (cap.type) {
    case 'explicit':
      return buildExplicitStrategy(cap, context);
    case 'automatic':
      return buildAutomaticStrategy(cap, context);
    case 'implicit':
      return buildImplicitStrategy(cap, context);
    case 'none':
      return buildNoopStrategy();
  }
}

/** Build strategy for explicit caching providers (Anthropic, Gemini). */
function buildExplicitStrategy(
  cap: ExplicitCacheCapability,
  context: CacheContext,
): CacheStrategy {
  const breakpoints: CacheBreakpoint[] = [];
  const stableTtl = getStableTtl(cap);
  const dynamicTtl = getDynamicTtl(cap);

  if (!stableTtl || !dynamicTtl) {
    logger.warn('[CacheStrategy] No TTL options for explicit provider', { provider: context.providerName });
    return buildNoopStrategy();
  }

  // Determine TTL for stable content (system + tools)
  // Use configured TTL if set, otherwise use longest available for stable content
  const stableTtlLabel = context.configuredTtl ?? stableTtl.label;
  const stableTtlSeconds = context.configuredTtl === '5m' ? 300 :
    context.configuredTtl === '1h' ? 3600 : stableTtl.seconds;

  const totalStableTokens = context.systemPromptTokens + context.toolTokens;

  // BP1: System prompt + tools (if above minimum)
  if (totalStableTokens >= cap.minCacheableTokens) {
    breakpoints.push({
      position: 'system_and_tools',
      ttl: stableTtlLabel,
      ttlSeconds: stableTtlSeconds,
      reason: `Cache stable prefix (${totalStableTokens} tokens, ${context.toolCount} tools)`,
    });
  }

  // BP2: Conversation history prefix (if there's meaningful history)
  // Only add if we have room for another breakpoint and conversation is substantial
  if (
    breakpoints.length < cap.maxBreakpoints &&
    context.conversationTurns >= 2 &&
    context.conversationTokens >= cap.minCacheableTokens
  ) {
    breakpoints.push({
      position: 'conversation_prefix',
      ttl: dynamicTtl.label,
      ttlSeconds: dynamicTtl.seconds,
      reason: `Cache conversation prefix (${context.conversationTurns} turns, ~${context.conversationTokens} tokens)`,
    });
  }

  // BP3: Last large tool result (if room and conversation has tool results)
  // This is a heuristic — the actual placement happens at request time
  if (
    breakpoints.length < cap.maxBreakpoints &&
    context.conversationTurns >= 3
  ) {
    breakpoints.push({
      position: 'last_tool_result',
      ttl: dynamicTtl.label,
      ttlSeconds: dynamicTtl.seconds,
      reason: 'Cache last large tool result',
    });
  }

  // BP4: Dynamic slot (reserved, only used if cache hit rate is poor)
  if (
    breakpoints.length < cap.maxBreakpoints &&
    context.recentCacheHitRate !== undefined &&
    context.recentCacheHitRate < 0.3
  ) {
    breakpoints.push({
      position: 'dynamic',
      ttl: dynamicTtl.label,
      ttlSeconds: dynamicTtl.seconds,
      reason: `Dynamic breakpoint (hit rate: ${(context.recentCacheHitRate * 100).toFixed(0)}%)`,
    });
  }

  return {
    breakpoints,
    prefixStable: true,
    refreshAfterTurns: 10,
  };
}

/** Build strategy for automatic caching providers (OpenAI, DeepSeek, Groq, etc.). */
function buildAutomaticStrategy(
  cap: Extract<ProviderCacheCapability, { type: 'automatic' }>,
  _context: CacheContext,
): CacheStrategy {
  return {
    breakpoints: [], // No explicit breakpoints — provider handles it
    prefixStable: true, // Critical: prefix stability maximizes automatic cache hits
    sessionAffinityHeader: cap.sessionAffinityHeader,
    refreshAfterTurns: 0, // No need to refresh — nothing to configure
  };
}

/** Build strategy for implicit caching (local runtimes). */
function buildImplicitStrategy(
  cap: Extract<ProviderCacheCapability, { type: 'implicit' }>,
  _context: CacheContext,
): CacheStrategy {
  return {
    breakpoints: [],
    prefixStable: true, // KV cache reuse depends on prefix stability
    keepAliveSeconds: cap.defaultKeepAliveSeconds,
    refreshAfterTurns: 0,
  };
}

/** Build a no-op strategy for providers without caching. */
function buildNoopStrategy(): CacheStrategy {
  return {
    breakpoints: [],
    prefixStable: false,
    refreshAfterTurns: 0,
  };
}

/**
 * CacheHitTracker — tracks cache hit rate over a sliding window of turns.
 */
export class CacheHitTracker {
  private metrics: CacheHitMetrics = {
    totalInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hitRate: 0,
    turns: 0,
  };

  /**
   * Record usage from a single turn.
   *
   * @param usage.inputTokens - Non-cached input tokens for this turn (tokens NOT served from
   *   cache). On Anthropic, this corresponds to `usage.input_tokens` (exclusive of cached
   *   tokens). Do NOT include cache_read_input_tokens or cache_creation_input_tokens here.
   * @param usage.cacheReadTokens - Tokens served from cache (cache hits).
   * @param usage.cacheWriteTokens - Tokens written to cache this turn (cache creation).
   */
  recordTurn(usage: {
    inputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    this.metrics.totalInputTokens += usage.inputTokens;
    this.metrics.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.metrics.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.metrics.turns += 1;

    // Hit rate: cacheReadTokens / (totalInputTokens + cacheReadTokens)
    // Exclude cacheWriteTokens: writes are a one-time creation cost, not processed input.
    const totalProcessed = this.metrics.totalInputTokens
      + this.metrics.cacheReadTokens;

    this.metrics.hitRate = totalProcessed > 0
      ? this.metrics.cacheReadTokens / totalProcessed
      : 0;
  }

  /** Get current metrics. */
  getMetrics(): Readonly<CacheHitMetrics> {
    return { ...this.metrics };
  }

  /** Get current hit rate (0-1). */
  getHitRate(): number {
    return this.metrics.hitRate;
  }

  /** Reset metrics (e.g., after strategy refresh). */
  reset(): void {
    this.metrics = {
      totalInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      hitRate: 0,
      turns: 0,
    };
  }
}
