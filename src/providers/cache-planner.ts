/**
 * Cache Strategy Planner — uses the helper model (or main model) to optimize
 * cache breakpoint placement for explicit-caching providers.
 * 
 * Two modes:
 *   1. Heuristic (default): Uses getDefaultStrategy() from cache-strategy.ts
 *   2. LLM-assisted: Sends context to the helper model for optimized strategy
 * 
 * The planner runs:
 *   - Once at session start (first turn)
 *   - Every N turns (configurable, default 10)
 *   - When cache hit rate drops below threshold
 */

import type {
  CacheStrategy,
  CacheContext,
  CacheBreakpoint,
  CacheHitTracker,
} from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { getDefaultStrategy } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { getCacheCapability } from '@pellux/goodvibes-sdk/platform/providers/cache-capability';
import type { ProviderCacheCapability } from '@pellux/goodvibes-sdk/platform/providers/cache-capability';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { HelperModel } from '@pellux/goodvibes-sdk/platform/config/helper-model';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/** Result of a strategy planning run. */
export interface PlanResult {
  strategy: CacheStrategy;
  source: 'heuristic' | 'helper' | 'cached';
  planTimeMs: number;
}

/**
 * CachePlanner — manages cache strategy lifecycle.
 * 
 * Caches the current strategy and refreshes it based on
 * turn count and hit rate thresholds.
 */
export class CachePlanner {
  private currentStrategy: CacheStrategy | null = null;
  private lastPlanTurn = 0;
  private turnsSinceLastPlan = 0;
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>;

  constructor(
    private readonly configManager: Pick<ConfigManager, 'get'>,
    private readonly helperModel: Pick<HelperModel, 'chat'>,
    cacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>,
  ) {
    this.cacheHitTracker = cacheHitTracker;
  }

  /**
   * Get the current cache strategy, planning a new one if needed.
   * 
   * Triggers re-planning when:
   *   - No strategy exists yet (first call)
   *   - refreshAfterTurns threshold reached
   *   - Cache hit rate dropped below warning threshold
   */
  async getStrategy(context: CacheContext): Promise<PlanResult> {
    const startMs = Date.now();
    this.turnsSinceLastPlan++;

    // Check if we need to refresh
    const needsRefresh = this.shouldRefresh(context);

    if (this.currentStrategy && !needsRefresh) {
      return {
        strategy: this.currentStrategy,
        source: 'cached',
        planTimeMs: Date.now() - startMs,
      };
    }

    // Try LLM-assisted planning first (if helper enabled)
    const helperEnabled = this.configManager.get('helper.enabled') as boolean;
    const cap = getCacheCapability(context.providerName);

    if (helperEnabled && cap.type === 'explicit') {
      try {
        const helperStrategy = await this.planWithHelper(context, cap);
        if (helperStrategy) {
          this.currentStrategy = helperStrategy;
          this.lastPlanTurn = this.turnsSinceLastPlan;
          this.turnsSinceLastPlan = 0;
          return {
            strategy: helperStrategy,
            source: 'helper',
            planTimeMs: Date.now() - startMs,
          };
        }
      } catch (err) {
        logger.debug('[CachePlanner] Helper planning failed, falling back to heuristic', {
          error: summarizeError(err),
        });
      }
    }

    // Fallback: heuristic strategy
    const heuristicStrategy = getDefaultStrategy(context);
    this.currentStrategy = heuristicStrategy;
    this.lastPlanTurn = this.turnsSinceLastPlan;
    this.turnsSinceLastPlan = 0;

    return {
      strategy: heuristicStrategy,
      source: 'heuristic',
      planTimeMs: Date.now() - startMs,
    };
  }

  /** Check if strategy needs refresh. */
  private shouldRefresh(context: CacheContext): boolean {
    // No strategy yet
    if (!this.currentStrategy) return true;

    // Refresh interval reached
    if (
      this.currentStrategy.refreshAfterTurns > 0 &&
      this.turnsSinceLastPlan >= this.currentStrategy.refreshAfterTurns
    ) {
      return true;
    }

    // Hit rate dropped below threshold
    const hitRateThreshold = this.configManager.get('cache.hitRateWarningThreshold') as number;
    if (
      context.recentCacheHitRate !== undefined &&
      context.recentCacheHitRate < hitRateThreshold &&
      this.cacheHitTracker.getMetrics().turns >= 3 // Need enough data
    ) {
      return true;
    }

    return false;
  }

  /**
   * Use the helper model to plan an optimized cache strategy.
   * Returns null if the helper can't produce a valid strategy.
   */
  private async planWithHelper(
    context: CacheContext,
    cap: ProviderCacheCapability,
  ): Promise<CacheStrategy | null> {
    const prompt = this.buildHelperPrompt(context, cap);

    const response = await this.helperModel.chat('cache_strategy', prompt, {
      maxTokens: 1024,
      systemPrompt: 'You are a cache optimization assistant. Respond ONLY with valid JSON matching the requested schema. No markdown, no explanation.',
    });

    if (!response) return null;

    try {
      // Extract JSON from response (handle potential markdown wrapping)
      let jsonStr = response.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(jsonStr) as {
        breakpoints?: Array<{
          position?: string;
          ttl?: string;
          ttlSeconds?: number;
          reason?: string;
        }>;
        refreshAfterTurns?: number;
      };

      if (!parsed.breakpoints || !Array.isArray(parsed.breakpoints)) {
        logger.debug('[CachePlanner] Helper returned invalid structure');
        return null;
      }

      // Validate and sanitize breakpoints
      const validPositions = new Set(['system_and_tools', 'conversation_prefix', 'last_tool_result', 'dynamic']);
      const validTtls = new Set(['5m', '1h']);

      const breakpoints: CacheBreakpoint[] = parsed.breakpoints
        .filter(bp => bp.position && validPositions.has(bp.position) && bp.ttl && validTtls.has(bp.ttl))
        .map(bp => ({
          position: bp.position as CacheBreakpoint['position'],
          ttl: bp.ttl!,
          ttlSeconds: bp.ttl === '1h' ? 3600 : 300,
          reason: bp.reason ?? 'Helper-planned breakpoint',
        }));

      // Enforce TTL ordering constraint: longer TTLs must come first
      breakpoints.sort((a, b) => b.ttlSeconds - a.ttlSeconds);

      // Enforce max breakpoints
      if (cap.type === 'explicit') {
        breakpoints.splice(cap.maxBreakpoints);
      }

      if (breakpoints.length === 0) {
        logger.debug('[CachePlanner] Helper produced no valid breakpoints');
        return null;
      }

      return {
        breakpoints,
        prefixStable: true,
        refreshAfterTurns: parsed.refreshAfterTurns ?? 10,
      };
    } catch (err) {
      logger.debug('[CachePlanner] Failed to parse helper response', {
        error: summarizeError(err),
        response: response.slice(0, 200),
      });
      return null;
    }
  }

  /** Build the prompt for the helper model. */
  private buildHelperPrompt(context: CacheContext, cap: ProviderCacheCapability): string {
    return `Optimize cache breakpoint placement for an LLM API request.

Provider: ${context.providerName}
Cache type: ${cap.type}
Max breakpoints: ${cap.type === 'explicit' ? cap.maxBreakpoints : 'N/A'}
Available TTLs: ${cap.type === 'explicit' ? cap.ttlOptions.map(t => `${t.label} (${t.writeCostMultiplier}x write)`).join(', ') : 'N/A'}
Read discount: ${cap.type === 'explicit' || cap.type === 'automatic' ? `${((1 - cap.readDiscount) * 100).toFixed(0)}% off` : 'N/A'}
Min cacheable tokens: ${cap.type === 'explicit' ? cap.minCacheableTokens : 'N/A'}

Current request context:
- System prompt: ~${context.systemPromptTokens} tokens
- Tools: ${context.toolCount} tools, ~${context.toolTokens} tokens
- Conversation: ${context.conversationTurns} turns, ~${context.conversationTokens} tokens
- Recent cache hit rate: ${context.recentCacheHitRate !== undefined ? `${(context.recentCacheHitRate * 100).toFixed(0)}%` : 'unknown'}

Rules:
- system_and_tools content NEVER changes during a session \u2192 prefer longest TTL
- conversation_prefix grows each turn but old turns are stable \u2192 5m TTL (refreshes on read)
- Longer TTL breakpoints MUST come before shorter TTL in content order
- Only place breakpoints if content exceeds ${cap.type === 'explicit' ? cap.minCacheableTokens : 1024} token minimum

Respond with JSON only:
{
  "breakpoints": [
    { "position": "system_and_tools|conversation_prefix|last_tool_result|dynamic", "ttl": "5m|1h", "reason": "brief explanation" }
  ],
  "refreshAfterTurns": 10
}`;
  }

  /** Force a strategy refresh on the next getStrategy() call. */
  invalidate(): void {
    this.currentStrategy = null;
  }

}
